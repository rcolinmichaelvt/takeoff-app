import Foundation
import Security
import CryptoKit

struct KeychainStore {
    let service: String
    func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ClientError.message("Secure storage is unavailable. Unlock your iPhone and try again.") }
        return result as? Data
    }
    func write(_ data: Data, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        let changes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var new = query; changes.forEach { new[$0.key] = $0.value }
            guard SecItemAdd(new as CFDictionary, nil) == errSecSuccess else { throw ClientError.message("Could not save your secure session.") }
        } else if status != errSecSuccess { throw ClientError.message("Could not update your secure session.") }
    }
    func remove(_ account: String) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ClientError.message("Could not clear secure storage.") }
    }
}

enum SigningBytes {
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ClientError.message("Could not create a secure sign-in request.")
        }
        return base64URL(Data(bytes))
    }
    static func message(method: String, target: String, body: Data, timestamp: String, nonce: String, token: String?) -> Data {
        Data(["takeoff-v1", method.uppercased(), target, hash(body), timestamp, nonce,
              token.map { hash(Data($0.utf8)) } ?? "-"].joined(separator: "\n").utf8)
    }
}

final class InstallationIdentity {
    private let enclave: SecureEnclave.P256.Signing.PrivateKey?
    private let software: P256.Signing.PrivateKey?
    var publicKey: P256.Signing.PublicKey { enclave?.publicKey ?? software!.publicKey }
    var publicPEM: String { publicKey.pemRepresentation }

    init(storage: KeychainStore) throws {
        #if targetEnvironment(simulator)
        enclave = nil
        if let data = try storage.read("simulator-signing-key") { software = try P256.Signing.PrivateKey(rawRepresentation: data) }
        else {
            let key = P256.Signing.PrivateKey(); try storage.write(key.rawRepresentation, account: "simulator-signing-key"); software = key
        }
        #else
        software = nil
        guard SecureEnclave.isAvailable else { throw ClientError.message("This device cannot provide the required secure signing key.") }
        if let data = try storage.read("enclave-signing-key") {
            enclave = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
        } else {
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                             .privateKeyUsage, &error) else {
                throw ClientError.message("Could not configure secure device access.")
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
            try storage.write(key.dataRepresentation, account: "enclave-signing-key"); enclave = key
        }
        #endif
    }
    func sign(_ data: Data) throws -> String {
        let signature = try enclave?.signature(for: data) ?? software!.signature(for: data)
        return SigningBytes.base64URL(signature.derRepresentation)
    }
}
