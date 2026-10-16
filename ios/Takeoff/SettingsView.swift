import SwiftUI

struct AreaSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var location = LocationPicker()
    @State private var zip = ""
    @State private var selected = Set<String>()
    @State private var initialized = false
    let onboarding: Bool
    private var validZIP: Bool { zip.utf8.count == 5 && zip.utf8.allSatisfy { (48...57).contains($0) } }
    var body: some View {
        Form {
            Section {
                TextField("Five-digit ZIP", text: $zip).keyboardType(.numberPad).textContentType(.postalCode)
                    .onChange(of: zip) { _, value in zip = String(value.filter { $0.isASCII && $0.isNumber }.prefix(5)) }
                Button { location.chooseZIP() } label: {
                    HStack { Label("Use current location for ZIP", systemImage: "location"); if location.busy { Spacer(); ProgressView() } }
                }.disabled(location.busy)
                if let error = location.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            } header: { Text("Your area") } footer: {
                Text("Takeoff monitors stores around your saved ZIP. Using your location only fills in the ZIP; it does not follow you as you travel.")
            }
            Section {
                HStack {
                    Button("Select all") { selected = Set(model.catalog.map(\.upc)) }
                    Spacer()
                    Button("Clear") { selected = [] }
                }.buttonStyle(.borderless)
                ForEach(model.catalog) { product in
                    Toggle(isOn: Binding(get: { selected.contains(product.upc) }, set: { value in
                        if value { selected.insert(product.upc) } else { selected.remove(product.upc) }
                    })) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(product.title)
                            Text(product.upc).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
                if model.catalog.isEmpty { Text("No products have been published yet.").foregroundStyle(.secondary) }
            } header: { Text("Followed products · \(selected.count)") } footer: {
                Text("Products and titles are provided by Takeoff. Choosing none stops your monitoring subscriptions. You can still browse areas covered by other members.")
            }
            Section {
                Button {
                    Task {
                        if await model.savePreferences(zip: zip, products: model.catalog.map(\.upc).filter { selected.contains($0) }) {
                            if !onboarding { dismiss() }
                        }
                    }
                } label: {
                    HStack { Text(onboarding ? "Start exploring" : "Save area and products").fontWeight(.semibold); Spacer(); if model.busy { ProgressView() } }
                }.disabled(!validZIP || model.busy)
            }
            if onboarding { Button("Sign out", role: .destructive) { Task { await model.logout() } }.disabled(model.busy) }
        }
        .navigationTitle(onboarding ? "Make it yours" : "Area & products")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !initialized else { return }; initialized = true
            zip = model.preferences.zip ?? ""
            selected = Set(onboarding ? model.catalog.map(\.upc) : model.preferences.products)
        }
        .onChange(of: location.zip) { _, value in if let value { zip = value } }
        .onDisappear { location.cancel() }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmLogout = false
    var body: some View {
        NavigationStack {
            Form {
                if let member = model.member {
                    Section("Your account") {
                        Label(member.displayName, systemImage: "person.crop.circle")
                        LabeledContent("Access", value: member.isModerator ? "Moderator" : "Member")
                        Text("One installation at a time. Moving access revokes the previous installation and starts a six-hour transfer cooldown.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Preferences") {
                    NavigationLink { AreaSettingsView(onboarding: false) } label: {
                        LabeledContent("Area & products", value: model.preferences.zip ?? "Choose ZIP")
                    }
                    NavigationLink("Alerts & pause") { AlertSettingsView() }
                }
                Section("Monitoring") {
                    if let status = model.monitoring {
                        LabeledContent("Server", value: status.enabled ? "Enabled" : "Not enabled")
                        LabeledContent("Shared searches", value: String(status.activeSearches))
                        if let last = status.lastSuccessAt {
                            LabeledContent("Last successful check") { Text(last, style: .relative).foregroundStyle(.secondary) }
                        }
                        if status.delayedSearches > 0 { Text("Some searches are delayed. Older observations are shown as unknown.").font(.footnote).foregroundStyle(.secondary) }
                    }
                    Text("This build refreshes while open and retrieves missed alerts when you return. Store predictions improve as clean restocks are observed. Phone push delivery and multi-store routes are coming later.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section { Button("Sign out", role: .destructive) { confirmLogout = true }.disabled(model.busy) }
            }.navigationTitle("Settings")
                .confirmationDialog("Sign out of this installation?", isPresented: $confirmLogout, titleVisibility: .visible) {
                    Button("Sign out", role: .destructive) { Task { await model.logout() } }
                } message: { Text("Your saved ZIP, preferences, and notes remain on the server.") }
        }
    }
}

struct AlertSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var alerts = AlertPreferences()
    @State private var initialized = false
    var body: some View {
        Form {
            Section {
                Toggle("Pause notifications", isOn: $alerts.paused)
            } footer: { Text("Selected events are still saved to your inbox while paused. Push delivery is not enabled in this milestone.") }
            Section("Stock changes") {
                Toggle("New stock starts selling", isOn: $alerts.firstDecrease)
                Toggle("Sold out", isOn: $alerts.soldOut)
                Toggle("Stock increases", isOn: $alerts.stockIncrease)
                Toggle("Other stock decreases", isOn: $alerts.anyDecrease)
                Toggle("Trip changes", isOn: $alerts.tripChanges)
            }
            Section {
                Toggle("Approaching predicted restock", isOn: $alerts.approaching)
            } header: { Text("Restock predictions") } footer: {
                Text("A departure warning uses the predicted shelf time minus your saved ZIP's drive estimate minus five minutes. At least three consistent samples and a recent drive estimate are needed. While this app is open, Apple Maps drive estimates are saved for up to 24 hours. These warnings appear in your inbox; phone pushes are not enabled yet.")
            }
            Button("Save alert preferences") {
                Task { if await model.savePreferences(alerts: alerts) { dismiss() } }
            }.disabled(model.busy)
        }.navigationTitle("Alerts & pause").navigationBarTitleDisplayMode(.inline)
            .onAppear { if !initialized { alerts = model.preferences.alerts; initialized = true } }
    }
}
