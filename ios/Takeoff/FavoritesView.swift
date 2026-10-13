import SwiftUI

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
