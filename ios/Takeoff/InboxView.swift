import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selected: StoreDestination?
    @State private var showClear = false
    var body: some View {
        NavigationStack {
            List {
                Section {
                    if model.events.isEmpty {
                        ContentUnavailableView("You're caught up", systemImage: "tray", description: Text("Selected stock changes from the past seven days appear here, including changes while the app was closed."))
                    }
                    ForEach(model.events) { event in
                        Button {
                            if let id = event.payload.storeId { selected = StoreDestination(id: id) }
                            Task { await model.markRead(event) }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Circle().fill(event.readAt == nil ? Theme.purple : .clear).frame(width: 8, height: 8).padding(.top, 6)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(event.title).font(.headline).foregroundStyle(.primary)
                                    if let address = event.payload.address { Text(address).font(.subheadline.weight(.medium)).foregroundStyle(.primary) }
                                    if let body = event.payload.body { Text(body).font(.subheadline).foregroundStyle(.secondary) }
                                    if let predicted = event.payload.predictedAt {
                                        Text("Estimated shelf time: \(predicted, format: .dateTime.month().day().hour().minute())")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    HStack {
                                        Text(event.createdAt, style: .relative)
                                        if event.payload.notificationsPaused == true { Text("· Paused at the time") }
                                    }.font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.vertical, 4)
                        }.accessibilityLabel("\(event.readAt == nil ? "Unread: " : "")\(event.title)")
                    }
                    if model.eventCursor != nil { Button("Load older alerts") { Task { await model.loadMoreEvents() } }.disabled(model.busy || model.refreshing) }
                } footer: { Text("Seven-day inbox. Phone push notifications are not connected in this build.") }
            }.navigationTitle("Inbox").refreshable { await model.refresh() }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Clear all notifications", role: .destructive) { showClear = true }
                            .disabled(model.events.isEmpty || model.busy || model.refreshing)
                    }
                }
                .confirmationDialog("Clear all existing inbox notifications?", isPresented: $showClear, titleVisibility: .visible) {
                    Button("Clear all notifications", role: .destructive) { Task { await model.clearNotifications() } }
                } message: { Text("This removes your existing inbox alerts. New alerts will continue to arrive.") }
                .sheet(item: $selected) { value in NavigationStack { StoreDetailView(storeID: value.id) }.environmentObject(model) }
        }
    }
}
