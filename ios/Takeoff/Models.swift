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
    struct Capabilities: Decodable { let monitoring: Bool; let remotePush: Bool; let appAttestRequired: Bool; var trips: Bool? = nil; var calendar: Bool? = nil }
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
    var tripChanges = true
    var paused = false
    init() {}
    private enum CodingKeys: String, CodingKey { case firstDecrease, soldOut, approaching, stockIncrease, anyDecrease, tripChanges, paused }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        firstDecrease = try values.decodeIfPresent(Bool.self, forKey: .firstDecrease) ?? true
        soldOut = try values.decodeIfPresent(Bool.self, forKey: .soldOut) ?? true
        approaching = try values.decodeIfPresent(Bool.self, forKey: .approaching) ?? true
        stockIncrease = try values.decodeIfPresent(Bool.self, forKey: .stockIncrease) ?? false
        anyDecrease = try values.decodeIfPresent(Bool.self, forKey: .anyDecrease) ?? false
        tripChanges = try values.decodeIfPresent(Bool.self, forKey: .tripChanges) ?? true
        paused = try values.decodeIfPresent(Bool.self, forKey: .paused) ?? false
    }
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
        switch self { case .available: return "Likely in stock"; case .back: return "Likely in back"
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
    var forecast: RestockForecast? = nil
    var id: String { upc }
    func effectiveStatus(at date: Date = Date()) -> ShelfStatus {
        if stale || date.timeIntervalSince(observedAt) > 9 * 60 { return .unknown }
        if status == .available {
            guard let decrease = lastDecreaseAt, date >= decrease, date.timeIntervalSince(decrease) < 7 * 24 * 60 * 60 else { return .unknown }
        }
        return status
    }
    var explanation: String {
        if stale || Date().timeIntervalSince(observedAt) > 9 * 60 { return "Last known quantity. Waiting for a fresh observation." }
        if effectiveStatus() == .unknown { return "Availability unknown—no recent sale signal, or monitoring was interrupted." }
        if status == .back { return "An increase was observed; a qualifying sale is still unconfirmed." }
        if status == .available { return "A decrease with stock remaining suggests items are for sale. This signal expires seven days after the latest decrease." }
        return "The latest successful check reported zero."
    }
}
struct Store: Decodable, Identifiable {
    let id: String; let retailer: String; let name: String; let address: String; let city: String; let state: String
    let postalCode: String?; let phone: String?; let latitude: Double?; let longitude: Double?; let coordinateSource: String?
    let distanceMiles: Double?; var favorite: Bool; var excluded: Bool; var privateNote: String; var publicNote: String
    let inventory: [StockItem]
    var timing: StoreTiming? = nil
    var travelEstimate: TravelEstimate? = nil
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
    struct Payload: Decodable {
        let storeId: String?; let title: String?; let body: String?; let notificationsPaused: Bool?
        let address: String?; let predictedAt: Date?
    }
    let id: Int; let kind: String; let payload: Payload; let createdAt: Date; var readAt: Date?
    var title: String { payload.title ?? kind.replacingOccurrences(of: "_", with: " ").capitalized }
}
struct InboxPage: Decodable { let events: [InboxEvent]; let nextCursor: Int? }

struct CalendarOptions: Codable, Equatable {
    var showModerator = true
    var showPrivate = true
    var showPredictions = true
    var favoritesOnly = true
}
struct CalendarEntry: Decodable, Identifiable {
    let id: String; let occurrenceId: String; let source: String
    let title: String; let description: String; let retailer: String; let location: String; let zip: String?
    let startsAt: Date; let endsAt: Date; let seriesStartsAt: Date; let seriesEndsAt: Date
    let timezone: String; let recurrence: String; let repeatUntil: Date?
    let version: Int; let canEdit: Bool; let hasImage: Bool; let updatedAt: Date
    var isShared: Bool { source == "moderator" }
    var sourceTitle: String { isShared ? "Moderator event" : "Only you" }
    func overlaps(_ day: Date, calendar: Calendar = .current) -> Bool {
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return false }
        return startsAt < end && endsAt > start
    }
}
struct CalendarPrediction: Decodable, Identifiable {
    let id: String; let storeId: String; let address: String; let expectedAt: Date
    let confidence: String; let titles: [String]
}
struct CalendarPage: Decodable {
    let events: [CalendarEntry]; let predictions: [CalendarPrediction]
    let nextCursor: String?; let preferences: CalendarOptions; let serverTime: Date
}
struct CalendarImage: Decodable { let base64: String; let width: Int; let height: Int }
struct CalendarDelete: Encodable { let version: Int }
struct CalendarWrite: Encodable {
    let version: Int; let visibility: String; let title: String; let description: String
    let retailer: String; let location: String; let zip: String?
    let startsAt: Date; let endsAt: Date; let timezone: String; let recurrence: String; let repeatUntil: Date?
    var imageBase64: String? = nil
    var removeImage = false
}

struct RestockForecast: Decodable {
    let batchId: Int; let startedAt: Date; let pendingQuantity: Int; let expectedAt: Date?
    let confidence: String; let sampleCount: Int; let state: String; let reason: String?
    var explanation: String {
        switch reason {
        case "overlapping_deliveries": return "More stock arrived before the previous batch started selling. Timing is uncertain."
        case "unknown_prior_stock": return "Earlier stock was already present when monitoring began. Timing is uncertain."
        case "hours_changed": return "Store hours changed during this restock. A new timing sample is needed."
        case "hours_unavailable", "hours_unavailable_at_arrival": return "Waiting for reliable opening hours before estimating this restock."
        case "old_samples": return "Recent restock samples are needed before estimating this delivery."
        default: return "Learning this store's timing from new stock to its first qualifying sale."
        }
    }
}
struct StoreTiming: Decodable {
    struct Pattern: Decodable, Identifiable {
        let weekday: Int; let day: String; let samples: Int; let averageOpenMinutes: Double
        var id: Int { weekday }
    }
    struct OpeningHours: Decodable {
        struct Day: Decodable, Identifiable { let day: String; let hours: String; var id: String { day } }
        let timezone: String; let updatedAt: Date; let days: [Day]
    }
    let sampleCount: Int; let averageOpenMinutes: Double?; let spreadOpenMinutes: Double?
    let confidence: String; let lastSampleAt: Date?; let hoursStatus: String
    let openingHours: OpeningHours?; let patterns: [Pattern]
    static func duration(_ minutes: Double) -> String {
        let value = max(1, Int(minutes.rounded()))
        return value < 60 ? "\(value) min" : "\(value / 60) hr \(value % 60) min"
    }
}
struct TravelEstimate: Decodable { let seconds: Int; let updatedAt: Date; let source: String }
struct TravelCandidate: Decodable {
    struct Point: Decodable {
        let latitude: Double; let longitude: Double
        var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
    }
    let storeId: String; let zip: String; let origin: Point; let destination: Point
}
struct TravelCandidates: Decodable { let candidates: [TravelCandidate] }
struct TravelUpdate: Encodable { let zip: String; let latitude: Double; let longitude: Double; let seconds: Int }

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

// Trips use server-owned inventory decisions and account-private MapKit measurements.
struct TripPoint: Codable, Equatable {
    let latitude: Double; let longitude: Double
    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
    var mapValue: String { "\(latitude),\(longitude)" }
}
struct TripLeg: Encodable {
    let storeId: String; let from: TripPoint; let to: TripPoint; let seconds: Int; let meters: Double
}
struct TripRequest: Encodable {
    var version: Int? = nil
    let products: [String]
    var storeIds: [String]? = nil
    var zip: String? = nil
    var origin: TripPoint? = nil
    var legs: [TripLeg]? = nil
    var departureAt: Date? = nil
}
struct TripResponse: Decodable { let version: Int; let trip: TripPlan? }
struct TripPreview: Decodable { let trip: TripPlan; let candidates: [Store] }
struct TripClear: Encodable { let version: Int }
struct TripStop: Decodable, Identifiable {
    let store: Store; let arrivalAt: Date?; let driveSeconds: Int?; let distanceMeters: Double?
    let state: String; let eligible: Bool; let warnings: [String]; let expectedAt: Date?
    var id: String { store.id }
    var point: TripPoint? {
        guard let coordinate = store.coordinate else { return nil }
        return .init(latitude: coordinate.latitude, longitude: coordinate.longitude)
    }
}
struct TripPlan: Decodable {
    let zip: String; let origin: TripPoint; let products: [String]; let departureAt: Date; let checkedAt: Date
    var originSource: String? = nil
    let stopMinutes: Int; let maxStops: Int; let stops: [TripStop]; let totalDriveSeconds: Int
    let needsReplan: Bool; let canOpen: Bool
    var storeIds: [String] { stops.map(\.id) }
    var originPoint: TripPoint { .init(latitude: origin.latitude, longitude: origin.longitude) }
    func isCurrent(at date: Date = Date()) -> Bool {
        originSource == "device" && canOpen && !needsReplan && date.timeIntervalSince(checkedAt) <= 15 * 60 &&
        date.timeIntervalSince(departureAt) <= 15 * 60 && stops.allSatisfy { stop in
            stop.store.inventory.contains { products.contains($0.upc) && $0.quantity > 0 && $0.effectiveStatus(at: date) != .unknown }
        }
    }
}
enum TripMaps {
    static func url(stops: [TripPoint]) -> URL? {
        guard !stops.isEmpty, stops.count <= 10,
              stops.allSatisfy({ $0.latitude.isFinite && $0.longitude.isFinite && abs($0.latitude) <= 90 && abs($0.longitude) <= 180 }) else { return nil }
        var url = URLComponents()
        url.scheme = "https"; url.host = "maps.apple.com"; url.path = "/directions"
        // Omitting source tells Apple Maps to navigate from the current location.
        url.queryItems = [URLQueryItem(name: "mode", value: "driving")]
        url.queryItems! += stops.dropLast().map { URLQueryItem(name: "waypoint", value: $0.mapValue) }
        url.queryItems!.append(URLQueryItem(name: "destination", value: stops.last!.mapValue))
        return url.url
    }
}
