import Foundation
import SwiftUI
import AuthenticationServices
import UIKit

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
    private var api: APIClient?
    private var pendingHandoff: LoginHandoff?
    private let webSignIn = WebSignIn()
    private var initialized = false
    private var revision = 0

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
            guard phase == .signedIn, revision == startedAtRevision else { return }
            preferences = settings; monitoring = status; stores = page.stores; storeCursor = page.nextCursor
            favorites = saved.stores; favoriteCursor = saved.nextCursor; events = inbox.events; eventCursor = inbox.nextCursor
            lastRefresh = Date(); connectionWarning = nil
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
    func logout() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { try await client().logout(); clearVisibleAccount() }
        catch { await report(error) }
    }
    private func clearVisibleAccount() {
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
