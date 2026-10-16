import Foundation
import SwiftUI
import AuthenticationServices
import UIKit
import MapKit

@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, signedIn }
    @Published var phase: Phase = .loading
    @Published var member: Member?
    @Published var preferences = Preferences.empty
    @Published var catalog: [Product] = []
    @Published var stores: [Store] = []
    @Published var favorites: [Store] = []
    @Published var events: [InboxEvent] = []
    @Published var monitoring: MonitoringStatus?
    @Published var scope = "nearby"
    @Published var storeCursor: String?
    @Published var favoriteCursor: String?
    @Published var eventCursor: Int?
    @Published var busy = false
    @Published var refreshing = false
    @Published var message: String?
    @Published var connectionWarning: String?
    @Published var needsTransfer = false
    @Published var lastRefresh: Date?
    @Published var trip: TripPlan?
    @Published var tripDraft: TripPlan?
    @Published var tripCandidates: [Store] = []
    @Published var tripBusy = false
    @Published var tripProgress: String?
    private var tripVersion = 0
    private var tripGeneration = UUID()
    private var tripRequest: MKDirections?
    private var api: APIClient?
    private var pendingHandoff: LoginHandoff?
    private let webSignIn = WebSignIn()
    private var initialized = false
    private var revision = 0
    private var driveRequest: MKDirections?
    private var refreshingDrive = false
    private var driveRetryAfter: [String: Date] = [:]
    private var nextDriveRequest = Date.distantPast

    func bootstrap() async {
        guard !initialized else { return }; initialized = true
        do {
            let client = try APIClient(base: AppConfiguration.validatedURL()); api = client
            if await client.hasSession() { try await loadAccount() } else { phase = .signedOut }
        } catch { phase = .signedOut; await report(error) }
    }
    private func client() throws -> APIClient {
        guard let api else { throw ClientError.message("Set the Railway URL in AppConfiguration.swift and rebuild.") }; return api
    }
    func login() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let api = try client()
            let (start, verifier) = try await api.startLogin(deviceName: String(UIDevice.current.name.prefix(60)))
            let callback = try await webSignIn.authenticate(url: start.authorizationUrl)
            let handoff = try WebSignIn.handoff(url: callback, expectedState: start.state, verifier: verifier)
            pendingHandoff = handoff
            try await api.exchange(handoff, transfer: false)
            pendingHandoff = nil; try await loadAccount()
        } catch let error as APIError where error.code == "DEVICE_TRANSFER_REQUIRED" { needsTransfer = true }
        catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin { pendingHandoff = nil }
        catch { pendingHandoff = nil; await report(error) }
    }
    func transfer() async {
        guard let handoff = pendingHandoff else { return }
        busy = true; defer { busy = false; pendingHandoff = nil }
        do { try await client().exchange(handoff, transfer: true); try await loadAccount() }
        catch { await report(error) }
    }
    func cancelTransfer() { pendingHandoff = nil }

    private func loadAccount() async throws {
        let api = try client()
        let profile: Member = try await api.get("/v1/me")
        let settings: Preferences = try await api.get("/v1/settings")
        let products: CatalogResponse = try await api.get("/v1/catalog")
        member = profile; preferences = settings; catalog = products.products; phase = .signedIn
        await refresh()
    }

    func refresh(quiet: Bool = false) async {
        guard phase == .signedIn, !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        let startedAtRevision = revision
        do {
            let api = try client()
            let settings: Preferences = try await api.get("/v1/settings")
            let status: MonitoringStatus = try await api.get("/v1/monitor/status")
            let page = try await refreshStores(api, query: "scope=\(scope)", minimumCount: stores.count)
            let saved = try await refreshStores(api, query: "scope=covered&favorites=true", minimumCount: favorites.count)
            let inbox = try await refreshInbox(api, minimumCount: events.count)
            var savedTrip: TripResponse?
            if member?.capabilities.trips == true { savedTrip = try await api.get("/v1/trip") }
            guard phase == .signedIn, revision == startedAtRevision else { return }
            preferences = settings; monitoring = status; stores = page.stores; storeCursor = page.nextCursor
            favorites = saved.stores; favoriteCursor = saved.nextCursor; events = inbox.events; eventCursor = inbox.nextCursor
            lastRefresh = Date(); connectionWarning = nil
            if !tripBusy, let savedTrip { trip = savedTrip.trip; tripVersion = savedTrip.version }
        } catch { if revision == startedAtRevision { await report(error, quiet: quiet) } }
    }
    private func refreshStores(_ api: APIClient, query: String, minimumCount: Int) async throws -> StoresPage {
        var page: StoresPage = try await api.get("/v1/stores?\(query)")
        var result = page.stores
        while result.count < minimumCount, let cursor = page.nextCursor {
            try Task.checkCancellation()
            page = try await api.get("/v1/stores?\(query)&after=\(cursor)")
            result += page.stores
        }
        return StoresPage(stores: result, nextCursor: page.nextCursor, serverTime: page.serverTime)
    }
    private func refreshInbox(_ api: APIClient, minimumCount: Int) async throws -> InboxPage {
        var page: InboxPage = try await api.get("/v1/events")
        var result = page.events
        while result.count < minimumCount, let cursor = page.nextCursor {
            try Task.checkCancellation()
            page = try await api.get("/v1/events?before=\(cursor)")
            result += page.events
        }
        return InboxPage(events: result, nextCursor: page.nextCursor)
    }
    func changeScope(_ value: String) async {
        guard !refreshing, scope != value else { return }; revision += 1; scope = value; stores = []; storeCursor = nil; await refresh()
    }
    func loadMoreStores(favoritesOnly: Bool = false) async {
        let cursor = favoritesOnly ? favoriteCursor : storeCursor
        guard let cursor, !busy, !refreshing else { return }; busy = true; defer { busy = false }
        revision += 1
        let startedAtRevision = revision
        do {
            let query = favoritesOnly ? "scope=covered&favorites=true" : "scope=\(scope)"
            let page: StoresPage = try await client().get("/v1/stores?\(query)&after=\(cursor)")
            guard phase == .signedIn, revision == startedAtRevision else { return }
            revision += 1
            if favoritesOnly {
                let old = Set(favorites.map(\.id)); favorites += page.stores.filter { !old.contains($0.id) }; favoriteCursor = page.nextCursor
            } else {
                let old = Set(stores.map(\.id)); stores += page.stores.filter { !old.contains($0.id) }; storeCursor = page.nextCursor
            }
        } catch { await report(error) }
    }
    func loadMoreEvents() async {
        guard let cursor = eventCursor, !busy, !refreshing else { return }; busy = true; defer { busy = false }
        revision += 1
        let startedAtRevision = revision
        do {
            let page: InboxPage = try await client().get("/v1/events?before=\(cursor)")
            guard phase == .signedIn, revision == startedAtRevision else { return }
            revision += 1
            let old = Set(events.map(\.id)); events += page.events.filter { !old.contains($0.id) }; eventCursor = page.nextCursor
        } catch { await report(error) }
    }
    func savePreferences(zip: String? = nil, products: [String]? = nil, alerts: AlertPreferences? = nil) async -> Bool {
        guard !busy else { return false }; busy = true; defer { busy = false }
        revision += 1
        do {
            let saved: Preferences = try await client().put("/v1/settings", body: PreferencesUpdate(zip: zip, products: products, alerts: alerts))
            guard phase == .signedIn else { return false }
            revision += 1
            if saved.zip != preferences.zip { stores = []; storeCursor = nil }
            preferences = saved
            await refresh(); return true
        } catch { await report(error); return false }
    }
    func fetchStore(_ id: String) async throws -> Store { try await client().get("/v1/stores/\(id)") }
    func history(_ id: String, before: Int? = nil) async throws -> HistoryPage {
        try await client().get("/v1/stores/\(id)/history" + (before.map { "?before=\($0)" } ?? ""))
    }
    func updateStore(_ id: String, change: StoreUpdate) async throws -> Store {
        revision += 1
        let store: Store = try await client().put("/v1/stores/\(id)/preferences", body: change)
        revision += 1; if phase == .signedIn { replace(store) }; return store
    }
    func publicNote(_ id: String, text: String) async throws -> Store {
        revision += 1
        let store: Store = try await client().put("/v1/stores/\(id)/public-note", body: PublicNoteUpdate(note: text))
        revision += 1; if phase == .signedIn { replace(store) }; return store
    }
    private func replace(_ store: Store) {
        if let index = stores.firstIndex(where: { $0.id == store.id }) { stores[index] = store }
        favorites.removeAll { $0.id == store.id }; if store.favorite { favorites.append(store) }
    }
    func markRead(_ event: InboxEvent) async {
        revision += 1
        do {
            let _: Acknowledgement = try await client().post("/v1/events/\(event.id)/read")
            revision += 1
            if let index = events.firstIndex(where: { $0.id == event.id }) { events[index].readAt = Date() }
        } catch { await report(error) }
    }
    func refreshDriveEstimate() async {
        guard phase == .signedIn, member?.capabilities.monitoring == true, preferences.alerts.approaching,
              !refreshingDrive, !tripBusy, Date() >= nextDriveRequest, UIApplication.shared.applicationState == .active else { return }
        refreshingDrive = true; defer { refreshingDrive = false; driveRequest = nil }
        do {
            let api = try client()
            let page: TravelCandidates = try await api.get("/v1/travel-estimates/needed")
            try Task.checkCancellation()
            guard let candidate = page.candidates.first(where: {
                $0.zip == preferences.zip && Date() >= (driveRetryAfter["\($0.zip):\($0.storeId)"] ?? .distantPast)
            }), phase == .signedIn, UIApplication.shared.applicationState == .active else { return }
            let key = "\(candidate.zip):\(candidate.storeId)"
            driveRetryAfter[key] = Date().addingTimeInterval(15 * 60)
            if driveRetryAfter.count > 500 { driveRetryAfter = driveRetryAfter.filter { $0.value > Date() } }
            let request = MKDirections.Request()
            request.source = MKMapItem(placemark: MKPlacemark(coordinate: candidate.origin.coordinate))
            request.destination = MKMapItem(placemark: MKPlacemark(coordinate: candidate.destination.coordinate))
            request.transportType = .automobile; request.departureDate = Date()
            let search = MKDirections(request: request); driveRequest = search
            let result = try await search.calculateETA()
            try Task.checkCancellation()
            guard phase == .signedIn, candidate.zip == preferences.zip else { return }
            guard result.expectedTravelTime.isFinite, result.expectedTravelTime > 0, result.expectedTravelTime <= 14400 else { return }
            let seconds = Int(ceil(result.expectedTravelTime))
            let _: Acknowledgement = try await api.put("/v1/travel-estimates/\(candidate.storeId)", body:
                TravelUpdate(zip: candidate.zip, latitude: candidate.destination.latitude,
                             longitude: candidate.destination.longitude, seconds: seconds))
            driveRetryAfter.removeValue(forKey: key)
        } catch {
            nextDriveRequest = Date().addingTimeInterval(60)
            if let mapError = error as? MKError, mapError.code == .loadingThrottled {
                nextDriveRequest = Date().addingTimeInterval(5 * 60)
            }
            if let apiError = error as? APIError, apiError.endsSession { await report(error, quiet: true) }
        }
    }
    func cancelDriveEstimate() { driveRequest?.cancel() }
    func saveDriveEstimate(_ store: Store, zip: String, seconds: Int) async {
        guard phase == .signedIn, zip == preferences.zip, let latitude = store.latitude, let longitude = store.longitude,
              !store.excluded, let distance = store.distanceMiles, distance <= 25, seconds > 0, seconds <= 14400 else { return }
        do {
            let _: Acknowledgement = try await client().put("/v1/travel-estimates/\(store.id)", body:
                TravelUpdate(zip: zip, latitude: latitude, longitude: longitude, seconds: seconds))
        } catch { if let value = error as? APIError, value.endsSession { await report(value) } }
    }
    func logout() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { try await client().logout(); clearVisibleAccount() }
        catch { await report(error) }
    }
    private func clearVisibleAccount() {
        cancelDriveEstimate(); driveRetryAfter = [:]; nextDriveRequest = .distantPast
        cancelTripPlanning(); trip = nil; tripDraft = nil; tripCandidates = []; tripVersion = 0
        revision += 1
        phase = .signedOut; member = nil; stores = []; favorites = []; events = []; catalog = []
        preferences = .empty; monitoring = nil; pendingHandoff = nil; needsTransfer = false
        storeCursor = nil; favoriteCursor = nil; eventCursor = nil; connectionWarning = nil
    }
    func report(_ error: Error, quiet: Bool = false) async {
        if error is CancellationError { return }
        if let apiError = error as? APIError, apiError.endsSession { try? await api?.clearSession(); clearVisibleAccount() }
        let explanation: String
        if let apiError = error as? APIError, apiError.code == "NOT_FOUND", phase != .signedIn {
            explanation = "Update Railway with the Milestone 2 backend files before connecting this app."
        } else { explanation = error.localizedDescription }
        if quiet && phase == .signedIn { connectionWarning = explanation }
        else { message = explanation }
    }
}

extension AppModel {
    func cancelTripPlanning() {
        tripGeneration = UUID(); tripRequest?.cancel()
    }
    func loadTripCandidates(products: [String]) async {
        guard !tripBusy, phase == .signedIn else { return }
        let account = member?.discordId
        do {
            let preview: TripPreview = try await client().post("/v1/trip/preview", body: TripRequest(products: products, storeIds: []))
            guard phase == .signedIn, member?.discordId == account else { return }
            tripCandidates = preview.candidates
        } catch { await report(error) }
    }
    func buildTrip(products: [String], storeIds: [String]? = nil) async {
        guard !tripBusy, phase == .signedIn, UIApplication.shared.applicationState == .active else { return }
        guard member?.capabilities.trips == true else {
            message = "Deploy the Milestone 4 backend before planning trips."; return
        }
        if storeIds?.isEmpty == true { await clearTrip(); return }
        tripBusy = true; revision += 1; cancelDriveEstimate()
        let generation = UUID(); tripGeneration = generation
        let account = member?.discordId
        defer { tripBusy = false; tripProgress = nil; tripRequest = nil; revision += 1 }
        do {
            let api = try client()
            let saved: TripResponse = try await api.get("/v1/trip")
            try Task.checkCancellation()
            guard tripGeneration == generation, phase == .signedIn, member?.discordId == account else { return }
            trip = saved.trip; tripVersion = saved.version
            tripProgress = "Finding an efficient stop order…"
            var request = TripRequest(products: products, storeIds: storeIds)
            let preview: TripPreview = try await api.post("/v1/trip/preview", body: request)
            try Task.checkCancellation()
            guard tripGeneration == generation, phase == .signedIn, member?.discordId == account else { return }
            tripDraft = preview.trip; tripCandidates = preview.candidates
            guard !preview.trip.stops.isEmpty else {
                message = "No fresh, likely-for-sale stores match these items. You can check Add stop for predicted arrivals."; return
            }
            var legs: [TripLeg] = [], from = preview.trip.originPoint
            var departure = preview.trip.departureAt
            for (index, stop) in preview.trip.stops.enumerated() {
                try Task.checkCancellation()
                guard tripGeneration == generation, UIApplication.shared.applicationState == .active else { return }
                guard let to = stop.point else { throw ClientError.message("A stop has no usable map coordinate.") }
                tripProgress = "Checking drive \(index + 1) of \(preview.trip.stops.count)…"
                let directions = MKDirections.Request()
                directions.source = MKMapItem(placemark: MKPlacemark(coordinate: from.coordinate))
                directions.destination = MKMapItem(placemark: MKPlacemark(coordinate: to.coordinate))
                directions.transportType = .automobile; directions.departureDate = departure
                let search = MKDirections(request: directions); tripRequest = search
                let estimate = try await search.calculateETA()
                try Task.checkCancellation()
                guard tripGeneration == generation, phase == .signedIn, member?.discordId == account else { return }
                guard estimate.expectedTravelTime.isFinite, estimate.expectedTravelTime > 0, estimate.expectedTravelTime <= 14400,
                      estimate.distance.isFinite, estimate.distance >= 0, estimate.distance <= 1_000_000 else {
                    throw ClientError.message("Apple Maps could not provide a usable driving estimate for this stop.")
                }
                let seconds = Int(ceil(estimate.expectedTravelTime))
                legs.append(.init(storeId: stop.id, from: from, to: to, seconds: seconds, meters: estimate.distance))
                from = to; departure = departure.addingTimeInterval(Double(seconds + preview.trip.stopMinutes * 60))
                // Keep routing calls sequential and give Maps room to throttle.
                if index + 1 < preview.trip.stops.count { try await Task.sleep(for: .seconds(1)) }
            }
            request.storeIds = preview.trip.storeIds; request.legs = legs
            request.zip = preview.trip.zip; request.origin = preview.trip.origin; request.departureAt = preview.trip.departureAt
            let checked: TripPreview = try await api.post("/v1/trip/preview", body: request)
            try Task.checkCancellation()
            guard tripGeneration == generation, phase == .signedIn, member?.discordId == account else { return }
            tripDraft = checked.trip; tripCandidates = checked.candidates
            guard checked.trip.canOpen else {
                message = "Review the route warnings and remove stops that cannot be reached in time. This draft hasn't replaced your saved trip."; return
            }
            request.version = saved.version
            let result: TripResponse = try await api.put("/v1/trip", body: request)
            guard tripGeneration == generation, phase == .signedIn, member?.discordId == account else { return }
            trip = result.trip; tripVersion = result.version; tripDraft = nil
        } catch {
            guard tripGeneration == generation, phase == .signedIn, member?.discordId == account else { return }
            if let mapError = error as? MKError, mapError.code == .loadingThrottled {
                message = "Apple Maps is limiting requests. Wait a few minutes, then tap Recalculate. Your saved trip is still available."
            } else { await report(error) }
        }
    }
    func clearTrip() async {
        guard !tripBusy, phase == .signedIn else { return }
        tripBusy = true; revision += 1
        let account = member?.discordId
        defer { tripBusy = false; revision += 1 }
        do {
            let result: TripResponse = try await client().post("/v1/trip/clear", body: TripClear(version: tripVersion))
            guard phase == .signedIn, member?.discordId == account else { return }
            trip = result.trip; tripVersion = result.version; tripDraft = nil; tripCandidates = []
        } catch { await report(error) }
    }
    func openTripInMaps() async {
        guard !tripBusy, tripDraft == nil, phase == .signedIn else { return }
        tripBusy = true; revision += 1
        let account = member?.discordId
        defer { tripBusy = false; revision += 1 }
        do {
            let response: TripResponse = try await client().get("/v1/trip")
            guard phase == .signedIn, member?.discordId == account, UIApplication.shared.applicationState == .active else { return }
            trip = response.trip; tripVersion = response.version
            guard let plan = response.trip, plan.isCurrent() else {
                message = "The trip needs a fresh check. Review the warnings and tap Recalculate."; return
            }
            if #available(iOS 18.4, *) {
                let stops = plan.stops.compactMap(\.point)
                guard stops.count == plan.stops.count, let url = TripMaps.url(origin: plan.originPoint, stops: stops) else { return }
                let opened = await UIApplication.shared.open(url)
                if !opened { message = "Apple Maps couldn't open this route. Try again from Trips." }
            } else if let first = plan.stops.first?.point {
                let source = MKMapItem(placemark: MKPlacemark(coordinate: plan.originPoint.coordinate))
                let destination = MKMapItem(placemark: MKPlacemark(coordinate: first.coordinate))
                MKMapItem.openMaps(with: [source, destination], launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
            }
        } catch { await report(error) }
    }
}
