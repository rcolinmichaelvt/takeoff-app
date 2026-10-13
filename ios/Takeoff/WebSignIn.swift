import AuthenticationServices
import UIKit

@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var completion: ((Result<URL, Error>) -> Void)?

    func authenticate(url: URL) async throws -> URL {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                completion = { continuation.resume(with: $0) }
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "takeoff") { [weak self] url, error in
                    Task { @MainActor in
                        if let error { self?.finish(.failure(error)) }
                        else if let url { self?.finish(.success(url)) }
                        else { self?.finish(.failure(ClientError.message("Discord did not return a sign-in result."))) }
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                self.session = session
                if !session.start() { finish(.failure(ClientError.message("Could not open Discord sign-in. Please try again."))) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.session?.cancel(); self?.finish(.failure(CancellationError()))
            }
        }
    }
    private func finish(_ result: Result<URL, Error>) {
        let callback = completion; completion = nil; session = nil; callback?(result)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    static func handoff(url: URL, expectedState: String, verifier: String) throws -> LoginHandoff {
        guard url.scheme == "takeoff", url.host == "auth", url.path == "/callback",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ClientError.message("The sign-in callback was invalid.")
        }
        let items = parts.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == expectedState else {
            throw ClientError.message("This callback did not match your sign-in request. Please start again.")
        }
        if let error = items.first(where: { $0.name == "error" })?.value {
            throw ClientError.message(error == "access_denied"
                ? "Sign-in was cancelled or this Discord account is not on the access list."
                : "Discord sign-in is temporarily unavailable. Please start again.")
        }
        guard items.filter({ $0.name == "login_code" }).count == 1,
              let code = items.first(where: { $0.name == "login_code" })?.value, code.count == 43 else {
            throw ClientError.message("The sign-in code is missing or invalid.")
        }
        return LoginHandoff(loginCode: code, verifier: verifier)
    }
}
