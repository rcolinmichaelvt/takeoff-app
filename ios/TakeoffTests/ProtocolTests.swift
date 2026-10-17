import XCTest
import CryptoKit
@testable import Takeoff

final class ProtocolTests: XCTestCase {
    func testCalendarOccurrencesKeepSeriesDatesAndExclusiveEndDay() throws {
        let json = #"{"id":"event","occurrenceId":"event:1","source":"moderator","title":"Release","description":"Details","retailer":"Target","location":"Test Street","zip":null,"startsAt":"2026-11-01T14:00:00Z","endsAt":"2026-11-02T00:00:00Z","seriesStartsAt":"2026-10-25T13:00:00Z","seriesEndsAt":"2026-10-25T23:00:00Z","timezone":"America/New_York","recurrence":"weekly","repeatUntil":"2026-11-08T23:00:00Z","version":2,"canEdit":false,"hasImage":true,"updatedAt":"2026-10-17T12:00:00Z"}"#
        let event = try APIJSON.decoder().decode(CalendarEntry.self, from: Data(json.utf8))
        var utc = Calendar(identifier: .gregorian); utc.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        XCTAssertTrue(event.isShared); XCTAssertTrue(event.hasImage); XCTAssertFalse(event.canEdit)
        XCTAssertNotEqual(event.startsAt, event.seriesStartsAt)
        XCTAssertTrue(event.overlaps(event.startsAt, calendar: utc))
        XCTAssertFalse(event.overlaps(event.endsAt, calendar: utc), "An event ending at midnight does not occupy the following day")
    }
    func testPrivateCalendarRequestOmitsImageAndAccountIdentifiers() throws {
        let request = CalendarWrite(version: 0, visibility: "private", title: "My stop", description: "", retailer: "Target",
            location: "Test Street", zip: nil, startsAt: Date(timeIntervalSince1970: 1800000000),
            endsAt: Date(timeIntervalSince1970: 1800003600), timezone: "America/New_York", recurrence: "none", repeatUntil: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: APIJSON.encoder().encode(request)) as? [String: Any])
        XCTAssertNil(object["imageBase64"]); XCTAssertNil(object["discordId"]); XCTAssertNil(object["owner_id"])
        XCTAssertNil(object["repeatUntil"]); XCTAssertEqual(object["visibility"] as? String, "private")
        XCTAssertEqual(object["startsAt"] as? String, "2027-01-15T08:00:00Z")
    }
    func testOlderServerCapabilitiesDoNotEnableCalendar() throws {
        let data = Data(#"{"monitoring":true,"remotePush":false,"appAttestRequired":false,"trips":true}"#.utf8)
        let capabilities = try APIJSON.decoder().decode(Member.Capabilities.self, from: data)
        XCTAssertNil(capabilities.calendar); XCTAssertEqual(capabilities.trips, true)
    }
    func testMapsURLPreservesOrderedWaypointsAndOneWayDestination() throws {
        let stops = [TripPoint(latitude: 38, longitude: -79), TripPoint(latitude: 39, longitude: -78), TripPoint(latitude: 40, longitude: -77)]
        let url = try XCTUnwrap(TripMaps.url(stops: stops))
        let query = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(url.host, "maps.apple.com")
        XCTAssertEqual(url.path, "/directions")
        XCTAssertEqual(query.filter { $0.name == "waypoint" }.compactMap(\.value), ["38.0,-79.0", "39.0,-78.0"])
        XCTAssertEqual(query.first { $0.name == "destination" }?.value, "40.0,-77.0")
        XCTAssertNil(query.first { $0.name == "source" }, "Maps should use current location")
        XCTAssertEqual(query.first { $0.name == "mode" }?.value, "driving")
    }
    func testMapsURLRejectsMissingStopsInvalidCoordinatesAndOversizedRoutes() {
        let origin = TripPoint(latitude: 37, longitude: -80)
        XCTAssertNil(TripMaps.url(stops: []))
        XCTAssertNil(TripMaps.url(stops: Array(repeating: origin, count: 11)))
        XCTAssertNil(TripMaps.url(stops: [.init(latitude: 91, longitude: 0)]))
        XCTAssertNil(TripMaps.url(stops: [.init(latitude: .nan, longitude: 0)]))
    }
    func testOlderPreferencesDefaultTripChangesWithoutChangingExistingChoices() throws {
        let old = #"{"firstDecrease":false,"soldOut":true,"approaching":true,"stockIncrease":false,"anyDecrease":false,"paused":true}"#
        let preferences = try APIJSON.decoder().decode(AlertPreferences.self, from: Data(old.utf8))
        XCTAssertTrue(preferences.tripChanges)
        XCTAssertTrue(preferences.paused)
        XCTAssertFalse(preferences.firstDecrease)
    }
    func testTripPreviewOmitsUnmeasuredLegsAndOwnerFields() throws {
        let request = TripRequest(products: ["196214158801"], storeIds: ["100"], origin: .init(latitude: 37.24, longitude: -80.41))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: APIJSON.encoder().encode(request)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["products", "storeIds", "origin"])
        let origin = try XCTUnwrap(object["origin"] as? [String: Double])
        XCTAssertEqual(origin["latitude"], 37.24)
    }
    func testAvailabilityExpiresAtSevenDaysDespiteFreshObservations() throws {
        let json = #"{"upc":"196214158801","title":"Test","quantity":7,"status":"available","stale":false,"observedAt":"2026-10-13T11:59:30Z","lastIncreaseAt":null,"lastDecreaseAt":"2026-10-06T12:00:00Z"}"#
        let stock = try APIJSON.decoder().decode(StockItem.self, from: Data(json.utf8))
        let boundary = try XCTUnwrap(stock.lastDecreaseAt).addingTimeInterval(7 * 24 * 60 * 60)
        XCTAssertEqual(stock.effectiveStatus(at: boundary.addingTimeInterval(-1)), .available)
        XCTAssertEqual(stock.effectiveStatus(at: boundary), .unknown)
        XCTAssertEqual(ShelfStatus.available.title, "Likely in stock")
    }
    struct Vector: Decodable {
        let method: String, target: String, body: String, timestamp: String, nonce: String, token: String
        let messageBase64: String, publicKey: String, signatureBase64: String
    }
    func testNodeAndSwiftAgreeOnSignedRequestBytesAndDERSignature() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "request-proof", withExtension: "json"))
        let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
        let bytes = SigningBytes.message(method: vector.method, target: vector.target, body: Data(vector.body.utf8),
                                         timestamp: vector.timestamp, nonce: vector.nonce, token: vector.token)
        XCTAssertEqual(bytes.base64EncodedString(), vector.messageBase64)
        let key = try P256.Signing.PublicKey(pemRepresentation: vector.publicKey)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(Data(base64Encoded: vector.signatureBase64)))
        XCTAssertTrue(key.isValidSignature(signature, for: bytes))
        let modified = SigningBytes.message(method: vector.method, target: vector.target, body: Data("{}".utf8),
                                            timestamp: vector.timestamp, nonce: vector.nonce, token: vector.token)
        XCTAssertFalse(key.isValidSignature(signature, for: modified))
    }

    @MainActor
    func testCallbackMustMatchOriginStateAndOneUseCodeShape() throws {
        let code = String(repeating: "A", count: 43)
        let valid = try XCTUnwrap(URL(string: "takeoff://auth/callback?state=expected&login_code=\(code)"))
        XCTAssertEqual(try WebSignIn.handoff(url: valid, expectedState: "expected", verifier: "verifier").loginCode, code)
        XCTAssertThrowsError(try WebSignIn.handoff(url: valid, expectedState: "different", verifier: "verifier"))
        for value in ["https://auth/callback?state=expected&login_code=\(code)",
                      "takeoff://auth/callback?state=expected&state=expected&login_code=\(code)",
                      "takeoff://auth/callback?state=expected&login_code=\(code)&login_code=\(code)"] {
            XCTAssertThrowsError(try WebSignIn.handoff(url: XCTUnwrap(URL(string: value)), expectedState: "expected", verifier: "verifier"))
        }
    }

    func testStaleDataLosesItsSaleClaimWhileKeepingTheLastQuantity() throws {
        let json = #"{"upc":"196214158801","title":"Test item","quantity":7,"status":"available","stale":false,"observedAt":"2026-10-13T12:00:00.000Z","lastIncreaseAt":null,"lastDecreaseAt":"2026-10-13T11:59:00Z"}"#
        let stock = try APIJSON.decoder().decode(StockItem.self, from: Data(json.utf8))
        XCTAssertEqual(stock.effectiveStatus(at: stock.observedAt.addingTimeInterval(60)), .available)
        XCTAssertEqual(stock.effectiveStatus(at: stock.observedAt.addingTimeInterval(541)), .unknown)
        XCTAssertEqual(stock.quantity, 7)
        XCTAssertNotNil(stock.lastDecreaseAt)
    }

    func testPartialSettingsDoNotEraseOtherServerPreferences() throws {
        let update = PreferencesUpdate(zip: nil, products: nil, alerts: .init())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: APIJSON.encoder().encode(update)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["alerts"])
    }

    func testPredictionDecodesWithoutChangingTheObservedShelfStatus() throws {
        let json = #"{"upc":"196214158801","title":"Test item","quantity":12,"status":"back","stale":false,"observedAt":"2026-10-13T18:05:00.000Z","lastIncreaseAt":"2026-10-13T17:00:00Z","lastDecreaseAt":null,"forecast":{"batchId":1,"startedAt":"2026-10-13T17:00:00Z","pendingQuantity":12,"expectedAt":"2026-10-13T18:00:00Z","confidence":"medium","sampleCount":3,"state":"expected_unconfirmed","reason":null}}"#
        let stock = try APIJSON.decoder().decode(StockItem.self, from: Data(json.utf8))
        XCTAssertEqual(stock.effectiveStatus(at: stock.observedAt), .back)
        XCTAssertEqual(stock.forecast?.sampleCount, 3)
        XCTAssertEqual(stock.forecast?.state, "expected_unconfirmed")
        XCTAssertEqual(stock.effectiveStatus(at: stock.observedAt.addingTimeInterval(600)), .unknown)
    }

    func testInboxAddressAndPredictionAreOptionalForOlderEvents() throws {
        let old = #"{"id":1,"kind":"sold_out","payload":{"storeId":"100","title":"Sold out","body":"2 → 0."},"createdAt":"2026-10-13T18:00:00Z","readAt":null}"#
        let event = try APIJSON.decoder().decode(InboxEvent.self, from: Data(old.utf8))
        XCTAssertNil(event.payload.address)
        XCTAssertNil(event.payload.predictedAt)
    }
}
