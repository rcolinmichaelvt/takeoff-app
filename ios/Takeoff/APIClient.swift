import Foundation
import CryptoKit

// Reject redirects so Authorization and signed request bytes never follow a new
// origin/path. The Discord browser session has its own redirect handling.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

actor APIClient {
    private let base: URL
    private let storage: KeychainStore
    private let identity: InstallationIdentity
    private let network: URLSession
    private var tokens: SessionTokens?
    private var refreshTask: Task<SessionTokens, Error>?

    init(base: URL) throws {
        self.base = base
        let namespace = SigningBytes.hash(Data(base.absoluteString.utf8))
        let storage = KeychainStore(service: "\(Bundle.main.bundleIdentifier ?? "Takeoff").\(namespace)")
        self.storage = storage
        identity = try InstallationIdentity(storage: storage)
        if let saved = try storage.read("session") { tokens = try APIJSON.decoder().decode(SessionTokens.self, from: saved) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 35
        configuration.timeoutIntervalForResource = 45
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        network = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    func hasSession() -> Bool { tokens != nil }

    func startLogin(deviceName: String) async throws -> (LoginStart, String) {
        struct Start: Encodable { let publicKey: String; let codeChallenge: String; let deviceName: String }
        let verifier = try SigningBytes.randomToken()
        let challenge = SigningBytes.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let start: LoginStart = try await send("POST", "/v1/auth/discord/start",
            body: APIJSON.encoder().encode(Start(publicKey: identity.publicPEM, codeChallenge: challenge, deviceName: deviceName)), signed: false)
        guard start.authorizationUrl.scheme == "https", start.authorizationUrl.host == "discord.com",
              start.authorizationUrl.path == "/oauth2/authorize" else { throw ClientError.message("Invalid sign-in destination from server.") }
        return (start, verifier)
    }

    func exchange(_ handoff: LoginHandoff, transfer: Bool) async throws {
        struct Exchange: Encodable { let loginCode: String; let codeVerifier: String; let transferExistingDevice: Bool }
        let result: SessionTokens = try await send("POST", "/v1/auth/exchange", body: APIJSON.encoder().encode(
            Exchange(loginCode: handoff.loginCode, codeVerifier: handoff.verifier, transferExistingDevice: transfer)))
        try save(result)
    }

    func clearSession() throws { tokens = nil; refreshTask?.cancel(); refreshTask = nil; try storage.remove("session") }

    func logout() async throws {
        let _: Acknowledgement = try await request("POST", "/v1/auth/logout", body: Data("{}".utf8))
        try clearSession()
    }

    func get<T: Decodable>(_ path: String) async throws -> T { try await request("GET", path) }
    func put<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        try await request("PUT", path, body: APIJSON.encoder().encode(body))
    }
    func post<T: Decodable>(_ path: String) async throws -> T { try await request("POST", path, body: Data("{}".utf8)) }

    private func save(_ value: SessionTokens) throws {
        try storage.write(APIJSON.encoder().encode(value), account: "session")
        tokens = value
    }

    private func refresh() async throws -> SessionTokens {
        if let refreshTask { return try await refreshTask.value }
        guard let current = tokens else { throw ClientError.message("Sign in to continue.") }
        struct Refresh: Encodable { let refreshToken: String }
        let task = Task<SessionTokens, Error> {
            let value: SessionTokens = try await self.send("POST", "/v1/auth/refresh",
                body: APIJSON.encoder().encode(Refresh(refreshToken: current.refreshToken)))
            try Task.checkCancellation()
            try self.save(value)
            return value
        }
        refreshTask = task
        do { let result = try await task.value; refreshTask = nil; return result }
        catch {
            // A lost response could already have consumed this refresh token.
            // Never automatically replay it. Require a new Discord sign-in.
            try? clearSession()
            throw APIError(code: "SESSION_REVOKED", message: "Your session could not be renewed. Please sign in again.", details: nil, requestId: nil)
        }
    }

    private func request<T: Decodable>(_ method: String, _ path: String, body: Data = Data()) async throws -> T {
        guard let current = tokens else { throw ClientError.message("Sign in to continue.") }
        do { return try await send(method, path, body: body, token: current.accessToken) }
        catch let error as APIError where error.code == "ACCESS_TOKEN_EXPIRED" {
            // Another request might already have completed the serialized refresh.
            let next: SessionTokens
            if let latest = tokens, latest.accessToken != current.accessToken { next = latest }
            else { next = try await refresh() }
            return try await send(method, path, body: body, token: next.accessToken)
        }
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: Data = Data(), token: String? = nil, signed: Bool = true) async throws -> T {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.host == base.host, url.scheme == "https", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ClientError.message("Invalid API request.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !body.isEmpty { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if signed {
            let timestamp = String(Int(Date().timeIntervalSince1970)), nonce = try SigningBytes.randomToken()
            let target = parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?\($0)" } ?? "")
            let message = SigningBytes.message(method: method, target: target, body: body, timestamp: timestamp, nonce: nonce, token: token)
            request.setValue(timestamp, forHTTPHeaderField: "X-Takeoff-Timestamp")
            request.setValue(nonce, forHTTPHeaderField: "X-Takeoff-Nonce")
            request.setValue(try identity.sign(message), forHTTPHeaderField: "X-Takeoff-Signature")
        }
        let (data, response) = try await network.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.message("No response from Takeoff.") }
        guard (200..<300).contains(response.statusCode) else {
            if let envelope = try? APIJSON.decoder().decode(ErrorEnvelope.self, from: data) { throw envelope.error }
            throw ClientError.message("The server returned HTTP \(response.statusCode). Check the Railway URL and deployment.")
        }
        do { return try APIJSON.decoder().decode(T.self, from: data) }
        catch { throw ClientError.message("The server response doesn't match this app. Install the Milestone 2 backend update.") }
    }
}
