import SwiftUI
import MapKit

struct DiscoverView: View {
    @EnvironmentObject private var model: AppModel
    @State private var camera: MapCameraPosition = .automatic
    @State private var selected: StoreDestination?
    @State private var showMap = true
    @State private var showExcluded = false
    @State private var productMode = "all"
    @State private var selectedProducts = Set<String>()
    @State private var showProducts = false
    @State private var showFavorites = false
    private var filter: Set<String>? {
        productMode == "all" ? nil : productMode == "followed" ? Set(model.preferences.products) : selectedProducts
    }
    private var visibleStores: [Store] {
        model.stores.filter { store in
            (showExcluded || !store.excluded) && (filter == nil || store.inventory.contains { filter!.contains($0.upc) })
        }.sorted { ($0.distanceMiles ?? .greatestFiniteMagnitude) < ($1.distanceMiles ?? .greatestFiniteMagnitude) }
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                controls
                StatusBanner()
                if showMap {
                    Map(position: $camera) {
                        ForEach(visibleStores) { store in
                            if let coordinate = store.coordinate {
                                Annotation(store.name, coordinate: coordinate) {
                                    Button { selected = StoreDestination(id: store.id) } label: {
                                        StorePin(status: store.status(for: filter), favorite: store.favorite)
                                    }.buttonStyle(.plain).accessibilityLabel("\(store.name), \(store.status(for: filter).title)")
                                }.annotationTitles(.hidden)
                            }
                        }
                    }.mapControls { MapCompass(); MapScaleView() }
                    .overlay(alignment: .bottomLeading) { legend.padding(12) }
                    .overlay(alignment: .topLeading) {
                        if visibleStores.filter({ $0.coordinate != nil }).isEmpty {
                            Text(model.stores.isEmpty ? "Waiting for store observations" : "Store coordinates are being resolved")
                                .font(.caption).padding(10).background(.regularMaterial, in: Capsule()).padding(12)
                        }
                    }
                } else {
                    List {
                        if visibleStores.isEmpty { ContentUnavailableView("No stores to show", systemImage: "mappin.slash", description: Text("Choose products, check your filters, or wait for the first inventory check.")) }
                        ForEach(visibleStores) { store in
                            Button { selected = StoreDestination(id: store.id) } label: { StoreRow(store: store, products: filter) }
                        }
                    }.listStyle(.plain).refreshable { await model.refresh() }
                }
                HStack {
                    Text("\(visibleStores.count) stores").font(.caption.weight(.semibold))
                    Spacer()
                    if let cursor = model.storeCursor, !cursor.isEmpty {
                        Button("Load more") { Task { await model.loadMoreStores() } }.font(.caption).disabled(model.busy)
                    } else if let last = model.lastRefresh {
                        Text("Updated \(last, style: .relative) ago").font(.caption2).foregroundStyle(.secondary)
                    }
                }.padding(12).background(.regularMaterial)
            }
            .navigationTitle("Takeoff").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showFavorites = true } label: { Image(systemName: "star.fill") }.accessibilityLabel("Favorites")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.refresh() } } label: {
                        if model.refreshing { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                    }.disabled(model.refreshing).accessibilityLabel("Refresh inventory")
                }
            }
            .sheet(item: $selected) { value in NavigationStack { StoreDetailView(storeID: value.id) }.environmentObject(model) }
            .sheet(isPresented: $showProducts) { productFilters }
            .sheet(isPresented: $showFavorites) { FavoritesView().environmentObject(model) }
            .onAppear { centerMap() }
            .onChange(of: model.preferences.zip) { _, _ in centerMap() }
            .onChange(of: model.scope) { _, _ in centerMap() }
        }
    }
    private func centerMap() {
        if model.scope == "nearby", let center = model.preferences.center {
            camera = .region(MKCoordinateRegion(center: center.coordinate, latitudinalMeters: 85000, longitudinalMeters: 85000))
        } else { camera = .automatic }
    }
    private var controls: some View {
        VStack(spacing: 10) {
            HStack {
                Text(model.preferences.zip.map { "ZIP \($0)" } ?? "Discover")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                Spacer()
            }
            Picker("Area", selection: Binding(get: { model.scope }, set: { value in Task { await model.changeScope(value) } })) {
                Text("Your area").tag("nearby"); Text("All covered areas").tag("covered")
            }.pickerStyle(.segmented).disabled(model.refreshing)
            HStack {
                Button { showProducts = true } label: {
                    Label(productMode == "all" ? "All items" : productMode == "followed" ? "Followed items" : "\(selectedProducts.count) items", systemImage: "line.3.horizontal.decrease")
                        .font(.subheadline.weight(.medium))
                }
                Spacer()
                Menu {
                    Toggle("Show excluded stores", isOn: $showExcluded)
                } label: { Image(systemName: showExcluded ? "eye" : "eye.slash") }.accessibilityLabel("Excluded store filter")
                Button { showMap.toggle() } label: { Image(systemName: showMap ? "list.bullet" : "map") }
                    .padding(.leading, 12).accessibilityLabel(showMap ? "Show store list" : "Show map")
            }
        }.padding(12).background(.bar)
    }
    private var legend: some View {
        HStack(spacing: 12) {
            ForEach(ShelfStatus.allCases, id: \.self) { status in
                HStack(spacing: 4) { Circle().fill(status.color).frame(width: 7, height: 7); Text(status == .available ? "For sale" : status == .back ? "Back" : status == .out ? "Out" : "Unknown") }
            }
        }.font(.caption2).padding(10).background(.regularMaterial, in: Capsule())
    }
    private var productFilters: some View {
        NavigationStack {
            Form {
                Picker("Show", selection: $productMode) {
                    Text("All catalog items").tag("all"); Text("My followed items").tag("followed"); Text("Choose items").tag("custom")
                }.pickerStyle(.inline)
                if productMode == "custom" {
                    Section("Items on the map") {
                        ForEach(model.catalog) { product in
                            Button {
                                if selectedProducts.contains(product.upc) { selectedProducts.remove(product.upc) } else { selectedProducts.insert(product.upc) }
                            } label: {
                                HStack { Text(product.title).foregroundStyle(.primary); Spacer(); if selectedProducts.contains(product.upc) { Image(systemName: "checkmark") } }
                            }
                        }
                    }
                }
                Text("Map filters don't change your monitored products or alert preferences.").font(.footnote).foregroundStyle(.secondary)
            }.navigationTitle("Map items").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showProducts = false } } }
        }
    }
}
