import SwiftUI
import MapKit

struct StoreDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let storeID: String
    @State private var store: Store?
    @State private var history: [HistoryEntry] = []
    @State private var historyCursor: Int?
    @State private var privateDraft = ""
    @State private var publicDraft = ""
    @State private var saving = false
    @State private var error: String?
    @State private var eta: String?
    @State private var etaBusy = false
    @State private var directions: MKDirections?
    @State private var revision = 0
    @State private var loading = false
    var body: some View {
        Group {
            if let store {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(store.name).font(.title2.bold())
                            Text(store.fullAddress).foregroundStyle(.secondary).textSelection(.enabled)
                            HStack(spacing: 18) {
                                if let miles = store.distanceMiles { Label(String(format: "%.1f mi", miles), systemImage: "location") }
                                if let eta { Label(eta, systemImage: "car.fill") }
                                else if let travel = store.travelEstimate {
                                    Label("~\(max(1, Int(ceil(Double(travel.seconds) / 60)))) min", systemImage: "car.fill")
                                }
                                if etaBusy { ProgressView() }
                            }.font(.subheadline)
                            if let phone = store.phone, let url = phoneURL(phone) { Link(destination: url) { Label(phone, systemImage: "phone") } }
                        }.padding(.vertical, 6)
                        if store.coordinate != nil {
                            Button("Check drive from saved ZIP") { Task { await calculateETA(store) } }.disabled(etaBusy)
                            Button("Open store in Apple Maps") { openMaps(store) }
                        }
                    } footer: {
                        Text(store.coordinateSource == "census" ? "Map position is geocoded from the store's address. Distance and drive time start at your saved ZIP's center." : "Distance and drive time start at your saved ZIP's center.")
                    }
                    Section {
                        Button { Task { await update(StoreUpdate(favorite: !store.favorite)) } } label: {
                            Label(store.favorite ? "Remove from favorites" : "Add to favorites", systemImage: store.favorite ? "star.fill" : "star")
                        }
                        Toggle("Exclude this store", isOn: Binding(get: { store.excluded }, set: { value in Task { await update(StoreUpdate(excluded: value)) } }))
                    } footer: { Text("Excluded stores are hidden by default on the map and don't generate new alerts for you.") }
                        .disabled(saving)
                    Section("Products at this store") {
                        if store.inventory.isEmpty { Text("No product observations yet.").foregroundStyle(.secondary) }
                        ForEach(store.inventory) { stock in StockRow(stock: stock) }
                    }.environment(\.timeZone, TimeZone(identifier: store.timing?.openingHours?.timezone ?? "") ?? .current)
                    if let timing = store.timing {
                        RestockTimingSection(timing: timing, travel: store.travelEstimate)
                    }
                    Section {
                        if !store.publicNote.isEmpty { Text(store.publicNote).textSelection(.enabled) }
                        else { Text("No public note yet.").foregroundStyle(.secondary) }
                        if model.member?.isModerator == true {
                            TextEditor(text: $publicDraft).frame(minHeight: 70).accessibilityLabel("Public moderator note")
                                .onChange(of: publicDraft) { _, value in publicDraft = String(value.prefix(2000)) }
                            Button("Save public note") { Task { await savePublic() } }.disabled(saving || publicDraft == store.publicNote)
                        }
                    } header: { Text("Moderator note") } footer: { Text("Public notes are visible to all members.") }
                    Section {
                        TextEditor(text: $privateDraft).frame(minHeight: 90).accessibilityLabel("Your private store note")
                            .onChange(of: privateDraft) { _, value in privateDraft = String(value.prefix(2000)) }
                        Button("Save my note") { Task { await update(StoreUpdate(privateNote: privateDraft)) } }.disabled(saving || privateDraft == store.privateNote)
                    } header: { Text("My private note") } footer: { Text("Only your account can read this note. Example: Limit is one per item. Up to 2,000 characters.") }
                    Section("Past seven days") {
                        if history.isEmpty { Text("No stock changes recorded yet.").foregroundStyle(.secondary) }
                        ForEach(history) { entry in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack { Text(entry.title).font(.subheadline.weight(.semibold)); Spacer(); Text(entry.change).font(.subheadline.monospacedDigit()) }
                                HStack {
                                    Text(entry.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                                    Spacer(); Text(entry.createdAt, format: .dateTime.month().day().hour().minute())
                                }.font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 3)
                        }
                        if historyCursor != nil { Button("Load earlier changes") { Task { await loadHistory(more: true) } }.disabled(saving) }
                    }
                }.refreshable { await load(resetDrafts: false) }
            } else if error == nil { ProgressView("Loading store…") }
            else { ContentUnavailableView("Store unavailable", systemImage: "wifi.exclamationmark", description: Text("Try refreshing after checking your connection.")) }
        }
        .navigationTitle("Store details").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .topBarTrailing) { Button { Task { await load(resetDrafts: false) } } label: { Image(systemName: "arrow.clockwise") }.disabled(saving) }
        }
        .task(id: model.lastRefresh) { await load(resetDrafts: store == nil) }
        .onDisappear { directions?.cancel() }
        .alert("Takeoff", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }
    private func load(resetDrafts: Bool) async {
        guard !saving, !loading else { return }; loading = true; defer { loading = false }
        let startedAtRevision = revision
        do {
            let latest = try await model.fetchStore(storeID)
            try Task.checkCancellation()
            guard revision == startedAtRevision else { return }
            if resetDrafts || store == nil { privateDraft = latest.privateNote; publicDraft = latest.publicNote }
            store = latest
            await loadHistory(more: false)
        } catch { await handle(error) }
    }
    private func loadHistory(more: Bool) async {
        do {
            let page = try await model.history(storeID, before: more ? historyCursor : nil)
            if more { let ids = Set(history.map(\.id)); history += page.history.filter { !ids.contains($0.id) } }
            else { history = page.history }
            historyCursor = page.nextCursor
        } catch { await handle(error) }
    }
    private func update(_ change: StoreUpdate) async {
        guard !saving else { return }; saving = true; defer { saving = false }
        revision += 1
        do { store = try await model.updateStore(storeID, change: change) }
        catch { await handle(error) }
    }
    private func savePublic() async {
        guard !saving else { return }; saving = true; defer { saving = false }
        revision += 1
        do { store = try await model.publicNote(storeID, text: publicDraft) }
        catch { await handle(error) }
    }
    private func handle(_ value: Error) async {
        if let apiError = value as? APIError, apiError.endsSession { await model.report(value); dismiss() }
        else if !(value is CancellationError) { error = value.localizedDescription }
    }
    private func phoneURL(_ phone: String) -> URL? {
        let digits = phone.filter { $0.isASCII && $0.isNumber }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }
    private func mapItem(_ store: Store) -> MKMapItem? {
        guard let point = store.coordinate else { return nil }
        let item = MKMapItem(placemark: MKPlacemark(coordinate: point)); item.name = store.name; return item
    }
    private func openMaps(_ store: Store) {
        // Opens a place, not a fabricated multi-stop itinerary. Trip planning is Milestone 4.
        mapItem(store)?.openInMaps()
    }
    private func calculateETA(_ store: Store) async {
        guard !etaBusy, let center = model.preferences.center, let zip = model.preferences.zip, let destination = mapItem(store) else { return }
        etaBusy = true; defer { etaBusy = false }
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: center.coordinate))
        request.destination = destination; request.transportType = .automobile; request.departureDate = Date()
        let search = MKDirections(request: request); directions = search
        do {
            let result = try await search.calculateETA()
            try Task.checkCancellation()
            guard zip == model.preferences.zip, result.expectedTravelTime.isFinite,
                  result.expectedTravelTime > 0, result.expectedTravelTime <= 14400 else { return }
            eta = "\(max(1, Int(ceil(result.expectedTravelTime / 60)))) min"
            await model.saveDriveEstimate(store, zip: zip, seconds: Int(ceil(result.expectedTravelTime)))
        }
        catch { if !Task.isCancelled { self.error = "Driving time is unavailable right now. You can try again later." } }
        directions = nil
    }
}

private struct StockRow: View {
    let stock: StockItem
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top) { Text(stock.title).font(.headline); Spacer(); Text("\(stock.quantity)").font(.title2.bold().monospacedDigit()) }
            StockBadge(status: stock.effectiveStatus())
            Text(stock.explanation).font(.caption).foregroundStyle(.secondary)
            if stock.effectiveStatus() != .unknown, let forecast = stock.forecast {
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(forecast.pendingQuantity) newly scanned units remain unconfirmed").font(.caption.weight(.semibold))
                    if let expected = forecast.expectedAt {
                        Text(expected <= Date() ? "Expected ready—unconfirmed" : "Estimated shelf time")
                            .font(.subheadline.weight(.medium))
                        Text(expected, format: .dateTime.month().day().hour().minute()).font(.subheadline)
                        Text("\(forecast.confidence.capitalized) confidence · \(forecast.sampleCount) samples").font(.caption)
                    } else { Text(forecast.explanation).font(.caption) }
                }.foregroundStyle(.secondary)
            }
            if let increase = stock.lastIncreaseAt { Text("Last increase: \(increase, format: .dateTime.month().day().hour().minute())").font(.caption2).foregroundStyle(.secondary) }
            if let decrease = stock.lastDecreaseAt { Text("Last decrease: \(decrease, format: .dateTime.month().day().hour().minute())").font(.caption2).foregroundStyle(.secondary) }
        }.padding(.vertical, 8)
    }
}

private struct RestockTimingSection: View {
    let timing: StoreTiming
    let travel: TravelEstimate?
    var body: some View {
        Section {
            if let average = timing.averageOpenMinutes {
                LabeledContent("Average open time", value: StoreTiming.duration(average))
                LabeledContent("Confidence", value: timing.confidence.capitalized)
                Text("\(timing.sampleCount) clean stock-to-sale samples across this store's products.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Learning this store's restock timing").font(.subheadline.weight(.medium))
                Text("A sample starts with new stock and ends when that new stock first sells. Older stock selling does not end the timer.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if timing.hoursStatus != "ready" {
                Text("Opening hours are unavailable or outdated. Predictions are paused for this store.").font(.caption).foregroundStyle(.secondary)
            }
            if !timing.patterns.isEmpty {
                DisclosureGroup("Observed arrival days") {
                    ForEach(timing.patterns) { pattern in
                        LabeledContent(pattern.day, value: "\(pattern.samples) · \(StoreTiming.duration(pattern.averageOpenMinutes)) avg")
                            .font(.caption)
                    }
                    Text("Counts reflect observed product batches with a clean first sale. Several products can arrive on one truck.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let hours = timing.openingHours {
                DisclosureGroup("Regular store hours") {
                    ForEach(hours.days) { day in LabeledContent(day.day.capitalized, value: day.hours).font(.caption) }
                }
            }
            if travel != nil {
                Text("Departure warnings use a saved Apple Maps drive estimate from your ZIP.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("A recent drive estimate from your saved ZIP is needed for departure warnings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: { Text("Restock timing") } footer: {
            Text("Only opening hours count. Estimates do not confirm shelf availability.")
        }
    }
}
