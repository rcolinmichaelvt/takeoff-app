import SwiftUI
import MapKit

struct FavoritesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selected: StoreDestination?
    var body: some View {
        NavigationStack {
            List {
                if model.favorites.isEmpty {
                    ContentUnavailableView("Your regular stops", systemImage: "star", description: Text("Open a store and favorite it to keep it here."))
                }
                ForEach(model.favorites.sorted { ($0.distanceMiles ?? .greatestFiniteMagnitude) < ($1.distanceMiles ?? .greatestFiniteMagnitude) }) { store in
                    Button { selected = StoreDestination(id: store.id) } label: { StoreRow(store: store) }
                }
                if model.favoriteCursor != nil {
                    Button("Load more favorites") { Task { await model.loadMoreStores(favoritesOnly: true) } }.disabled(model.busy || model.refreshing)
                }
            }.navigationTitle("Favorites").refreshable { await model.refresh() }
                .sheet(item: $selected) { value in NavigationStack { StoreDetailView(storeID: value.id) }.environmentObject(model) }
        }
    }
}

// Kept in an existing target member so incremental updates preserve signing and
// require no Xcode project replacement or manual file membership changes.
struct TripsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var product = ""
    @State private var showCandidates = false
    @State private var showClear = false
    @State private var selectedStore: StoreDestination?
    private var products: [String] { product.isEmpty ? model.preferences.products : [product] }
    private var plan: TripPlan? { model.tripDraft ?? model.trip }
    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 30)) { timeline in
                List {
                    if model.member?.capabilities.trips != true {
                        ContentUnavailableView("Update Railway", systemImage: "arrow.triangle.2.circlepath",
                            description: Text("Trips need the Milestone 4 backend. Deploy it, then reopen the app."))
                    } else {
                        Section {
                            Picker("New route items", selection: $product) {
                                Text("All followed items").tag("")
                                ForEach(model.catalog.filter { model.preferences.products.contains($0.upc) }) { item in
                                    Text(item.title).tag(item.upc)
                                }
                            }
                            Button {
                                Task { await model.buildTrip(products: products) }
                            } label: { Label("Suggest a route", systemImage: "wand.and.stars") }
                                .disabled(model.tripBusy || products.isEmpty)
                            if let progress = model.tripProgress { HStack { ProgressView(); Text(progress).font(.subheadline) } }
                        } footer: {
                            Text("Start at your current location with up to 10 stores likely in stock in your saved area. Apple Maps checks the drives. Your monitored ZIP stays fixed.")
                        }
                        if model.tripDraft != nil {
                            Section {
                                Label("Unsaved draft", systemImage: "pencil.and.list.clipboard").font(.headline)
                                Text("Review warnings or recalculate. Your last saved trip remains on the server.").font(.caption)
                                Button("Discard draft") { model.tripDraft = nil }.disabled(model.tripBusy)
                            }
                        }
                        if let plan {
                            routeContent(plan, at: timeline.date)
                        } else {
                            Section {
                                ContentUnavailableView("Plan your next stops", systemImage: "map",
                                    description: Text("Choose your items and suggest a route. Add or remove stores to recalculate the order."))
                            }
                        }
                    }
                }
            }
            .navigationTitle("Trips")
            .refreshable { await model.refresh() }
            .sheet(isPresented: $showCandidates) { candidatePicker }
            .sheet(item: $selectedStore) { destination in
                NavigationStack { StoreDetailView(storeID: destination.id) }.environmentObject(model)
            }
            .confirmationDialog("Clear your saved trip?", isPresented: $showClear, titleVisibility: .visible) {
                Button("Clear trip", role: .destructive) { Task { await model.clearTrip() } }
            }
            .onChange(of: model.preferences.products) { _, items in if !items.contains(product) { product = "" } }
        }
    }
    @ViewBuilder
    private func routeContent(_ plan: TripPlan, at date: Date) -> some View {
        Section {
            TripMap(plan: plan).frame(height: 230).listRowInsets(EdgeInsets())
            LabeledContent("Start", value: plan.originSource == "device" ? "Your location when planned" : "Recalculate from current location")
            if plan.totalDriveSeconds > 0 {
                Text("\(plan.stops.count) stops · \(Int(ceil(Double(plan.totalDriveSeconds) / 60))) min driving").font(.headline)
            } else { Text("\(plan.stops.count) stops · Driving times pending").font(.headline) }
            Text("Arrival estimates allow \(plan.stopMinutes) minutes at each earlier stop. Times are shown in your iPhone's timezone.")
                .font(.caption).foregroundStyle(.secondary)
            if !plan.isCurrent(at: date) {
                Label("Review warnings and recalculate before opening Maps.", systemImage: "exclamationmark.triangle")
                    .font(.subheadline).foregroundStyle(.orange)
            }
        }
        Section("Your stops") {
            ForEach(Array(plan.stops.enumerated()), id: \.element.id) { index, stop in
                VStack(alignment: .leading, spacing: 8) {
                    Button { selectedStore = StoreDestination(id: stop.id) } label: {
                        HStack(alignment: .top) {
                            Text("\(index + 1)").font(.headline).frame(width: 26)
                            Text(stop.store.fullAddress).font(.headline).foregroundStyle(.primary)
                            Spacer(); Image(systemName: "chevron.right").font(.caption)
                        }
                    }.buttonStyle(.borderless)
                    StockBadge(status: stop.store.status(for: Set(plan.products)))
                    if let arrival = stop.arrivalAt, let seconds = stop.driveSeconds {
                        Text("Arrive \(arrival, format: .dateTime.hour().minute()) · \(max(1, Int(ceil(Double(seconds) / 60)))) min drive")
                            .font(.subheadline)
                    }
                    ForEach(stop.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                    }
                    Button("Remove stop", role: .destructive) {
                        Task { await model.buildTrip(products: plan.products, storeIds: plan.storeIds.filter { $0 != stop.id }) }
                    }.buttonStyle(.borderless).font(.caption).disabled(model.tripBusy)
                }.padding(.vertical, 6)
            }
            Button {
                Task {
                    await model.loadTripCandidates(products: plan.products)
                    showCandidates = true
                }
            } label: { Label("Add stop", systemImage: "plus.circle") }
                .disabled(model.tripBusy || plan.stops.count >= plan.maxStops)
        }
        Section {
            Button("Recalculate order and driving times") {
                Task { await model.buildTrip(products: plan.products, storeIds: plan.storeIds) }
            }.disabled(model.tripBusy || plan.stops.isEmpty)
            Button { Task { await model.openTripInMaps() } } label: {
                if #available(iOS 18.4, *) { Label("Open route in Apple Maps", systemImage: "arrow.triangle.turn.up.right.diamond.fill") }
                else { Label("Open first stop in Apple Maps", systemImage: "arrow.triangle.turn.up.right.diamond.fill") }
            }.disabled(model.tripBusy || model.tripDraft != nil || !plan.isCurrent(at: date))
            Button("Clear trip", role: .destructive) { showClear = true }.disabled(model.tripBusy)
        } footer: {
            Text("The route ends at the last store. Takeoff refreshes stock when open and saves trip changes to your inbox. Return here to replan; a route already open in Apple Maps stays as it was.")
        }
    }
    private var candidatePicker: some View {
        NavigationStack {
            List {
                let ids = Set(plan?.storeIds ?? [])
                let candidates = model.tripCandidates.filter { !ids.contains($0.id) }
                if candidates.isEmpty { Text("No other eligible stores for these items right now.").foregroundStyle(.secondary) }
                ForEach(candidates) { store in
                    Button {
                        let selectedProducts = plan?.products ?? products
                        let stopIDs = (plan?.storeIds ?? []) + [store.id]
                        showCandidates = false
                        Task { await model.buildTrip(products: selectedProducts, storeIds: stopIDs) }
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            StoreRow(store: store, products: Set(plan?.products ?? products))
                            Text("Checks driving time, opening hours, and predicted stock before saving.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(model.tripBusy)
                }
            }.navigationTitle("Add a stop").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showCandidates = false } } }
        }
    }
}

private struct TripMap: View {
    let plan: TripPlan
    var body: some View {
        Map(initialPosition: .automatic) {
            Annotation("Trip start", coordinate: plan.origin.coordinate) {
                Image(systemName: "location.fill").padding(8).foregroundStyle(.white).background(Theme.purple, in: Circle())
            }
            ForEach(Array(plan.stops.enumerated()), id: \.element.id) { index, stop in
                if let coordinate = stop.store.coordinate {
                    Annotation(stop.store.address, coordinate: coordinate) {
                        Text("\(index + 1)").font(.headline).padding(8).foregroundStyle(.white)
                            .background(stop.eligible ? Theme.purple : Color.gray, in: Circle())
                    }
                }
            }
        }.mapControls { MapCompass() }.id(plan.origin.mapValue + plan.storeIds.joined(separator: ":"))
            .accessibilityLabel("Planned stops in visiting order")
    }
}
