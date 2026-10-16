import XCTest
import CryptoKit
@testable import Takeoff

final class ProtocolTests: XCTestCase {
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
