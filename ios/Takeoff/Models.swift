import Foundation
import CoreLocation

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

struct APIError: Decodable, LocalizedError {
    struct Details: Decodable { let retryAfterSeconds: Int? }
    let code: String
    let message: String
    let details: Details?
    let requestId: String?
    var errorDescription: String? {
        if let seconds = details?.retryAfterSeconds, seconds > 0 {
            return "\(message) Try again in about \(max(1, Int(ceil(Double(seconds) / 60)))) minutes."
        }
        return message
    }
    var endsSession: Bool { ["SESSION_REVOKED", "INVALID_REFRESH_TOKEN", "REFRESH_TOKEN_REUSED", "ACCESS_DENIED"].contains(code) }
}
struct ErrorEnvelope: Decodable { let error: APIError }
struct EmptyBody: Encodable {}
struct Acknowledgement: Decodable {}

struct SessionTokens: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
    let sessionExpiresAt: Date
    let serverTime: Date
}
struct LoginStart: Decodable { let authorizationUrl: URL; let state: String; let keyId: String; let expiresIn: Int }
struct LoginHandoff { let loginCode: String; let verifier: String }
struct Member: Decodable {
    struct Capabilities: Decodable { let monitoring: Bool; let remotePush: Bool; let appAttestRequired: Bool }
    let discordId: String
    let displayName: String
    let role: String
    let deviceName: String
    let nextDeviceTransferAt: Date
    let capabilities: Capabilities
    var isModerator: Bool { role == "moderator" }
}
struct Product: Decodable, Identifiable, Hashable { let retailer: String; let upc: String; let title: String; var id: String { upc } }
struct CatalogResponse: Decodable { let products: [Product] }
struct SavedCenter: Codable {
    let latitude: Double; let longitude: Double; let label: String
    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
}
struct AlertPreferences: Codable, Equatable {
    var firstDecrease = true
    var soldOut = true
    var approaching = true
    var stockIncrease = false
    var anyDecrease = false
    var paused = false
}
struct Preferences: Codable {
    var zip: String?
    var center: SavedCenter?
    var radiusMiles: Int
    var products: [String]
    var alerts: AlertPreferences
    static let empty = Preferences(zip: nil, center: nil, radiusMiles: 25, products: [], alerts: .init())
}
struct PreferencesUpdate: Encodable { let zip: String?; let products: [String]?; let alerts: AlertPreferences? }
struct MonitoringStatus: Decodable {
    let enabled: Bool; let activeSearches: Int; let lastSuccessAt: Date?; let delayedSearches: Int
    let predictionsAvailable: Bool; let remotePushAvailable: Bool
}

enum ShelfStatus: String, Codable, CaseIterable {
    case available, back, out, unknown
    var title: String {
        switch self { case .available: return "Likely for sale"; case .back: return "Likely in back"
        case .out: return "Sold out"; case .unknown: return "Unknown" }
    }
    var symbol: String {
        switch self { case .available: return "checkmark"; case .back: return "shippingbox.fill"
        case .out: return "xmark"; case .unknown: return "questionmark" }
    }
}
struct StockItem: Decodable, Identifiable {
    let upc: String; let title: String; let quantity: Int; let status: ShelfStatus; let stale: Bool
    let observedAt: Date; let lastIncreaseAt: Date?; let lastDecreaseAt: Date?
    var id: String { upc }
    func effectiveStatus(at date: Date = Date()) -> ShelfStatus {
        stale || date.timeIntervalSince(observedAt) > 9 * 60 ? .unknown : status
    }
    var explanation: String {
        if stale || Date().timeIntervalSince(observedAt) > 9 * 60 { return "Last known quantity. Waiting for a fresh observation." }
        if status == .unknown { return "Availability unknown—monitoring started recently or was interrupted." }
        if status == .back { return "An increase was observed; a qualifying sale is still unconfirmed." }
        if status == .available { return "A qualifying decrease suggests stock is being sold." }
        return "The latest successful check reported zero."
    }
}
struct Store: Decodable, Identifiable {
    let id: String; let retailer: String; let name: String; let address: String; let city: String; let state: String
    let postalCode: String?; let phone: String?; let latitude: Double?; let longitude: Double?; let coordinateSource: String?
    let distanceMiles: Double?; var favorite: Bool; var excluded: Bool; var privateNote: String; var publicNote: String
    let inventory: [StockItem]
    var coordinate: CLLocationCoordinate2D? {
        guard let latitude, let longitude, abs(latitude) <= 90, abs(longitude) <= 180 else { return nil }
        return .init(latitude: latitude, longitude: longitude)
    }
    var fullAddress: String { [address, city, state, postalCode ?? ""].filter { !$0.isEmpty }.joined(separator: ", ") }
    func status(for products: Set<String>? = nil) -> ShelfStatus {
        let values = inventory.filter { products == nil || products!.contains($0.upc) }.map { $0.effectiveStatus() }
        if values.contains(.available) { return .available }
        if values.contains(.back) { return .back }
        if values.isEmpty || values.contains(.unknown) { return .unknown }
        return .out
    }
}
struct StoresPage: Decodable { let stores: [Store]; let nextCursor: String?; let serverTime: Date }
struct StoreUpdate: Encodable { var favorite: Bool?; var excluded: Bool?; var privateNote: String? }
struct PublicNoteUpdate: Encodable { let note: String }
struct HistoryEntry: Decodable, Identifiable {
    let id: Int; let upc: String; let title: String; let previousQuantity: Int?; let quantity: Int
    let status: ShelfStatus; let kind: String; let createdAt: Date
    var change: String { "\(previousQuantity.map(String.init) ?? "—") → \(quantity)" }
}
struct HistoryPage: Decodable { let history: [HistoryEntry]; let nextCursor: Int? }
struct InboxEvent: Decodable, Identifiable {
    struct Payload: Decodable { let storeId: String?; let title: String?; let body: String?; let notificationsPaused: Bool? }
    let id: Int; let kind: String; let payload: Payload; let createdAt: Date; var readAt: Date?
    var title: String { payload.title ?? kind.replacingOccurrences(of: "_", with: " ").capitalized }
}
struct InboxPage: Decodable { let events: [InboxEvent]; let nextCursor: Int? }

enum APIJSON {
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { value in
            let container = try value.singleValueContainer()
            let string = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: string) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: string) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid server timestamp")
        }
        return decoder
    }
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; return encoder
    }
}
