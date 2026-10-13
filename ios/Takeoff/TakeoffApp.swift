import SwiftUI

@main
struct TakeoffApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup { RootView().environmentObject(model).tint(Theme.purple) }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Group {
            switch model.phase {
            case .loading: ProgressView("Opening Takeoff…")
            case .signedOut: SignInView()
            case .signedIn:
                if model.preferences.zip == nil {
                    NavigationStack { AreaSettingsView(onboarding: true) }
                } else {
                    TabView {
                        DiscoverView().tabItem { Label("Discover", systemImage: "map.fill") }
                        FavoritesView().tabItem { Label("Favorites", systemImage: "star.fill") }
                        InboxView().tabItem { Label("Inbox", systemImage: "tray.fill") }
                            .badge(model.events.filter { $0.readAt == nil }.count)
                        SettingsView().tabItem { Label("Settings", systemImage: "gearshape.fill") }
                    }
                }
            }
        }
        .task { await model.bootstrap() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await model.refresh(quiet: true)
                do { try await Task.sleep(for: .seconds(30)) } catch { break }
            }
        }
        .alert("Takeoff", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
            Button("OK") { model.message = nil }
        } message: { Text(model.message ?? "") }
        .confirmationDialog("Move access to this iPhone?", isPresented: $model.needsTransfer, titleVisibility: .visible) {
            Button("Move access") { Task { await model.transfer() } }
            Button("Cancel", role: .cancel) { model.cancelTransfer() }
        } message: { Text("The previous installation will lose access immediately. After a transfer, you must wait six hours before moving again.") }
    }
}

struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Spacer()
            Image(systemName: "paperplane.fill").font(.system(size: 48)).foregroundStyle(Theme.purple)
                .padding(24).background(Theme.purple.opacity(0.1), in: RoundedRectangle(cornerRadius: 28))
            VStack(alignment: .leading, spacing: 12) {
                Text("Takeoff").font(.system(size: 46, weight: .bold, design: .rounded))
                Text("Know what’s nearby.\nBe ready when it lands.").font(.title2).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 15) {
                Label("Your ZIP. Your products.", systemImage: "mappin.and.ellipse")
                Label("Store notes and stock history", systemImage: "list.bullet.rectangle")
                Label("One authorized iPhone at a time", systemImage: "lock.iphone")
            }.font(.subheadline)
            Spacer()
            Button { Task { await model.login() } } label: {
                HStack { if model.busy { ProgressView().tint(.white) }; Text("Continue with Discord").fontWeight(.semibold); Spacer(); Image(systemName: "arrow.right") }
                    .padding(18).foregroundStyle(.white).background(Theme.purple, in: RoundedRectangle(cornerRadius: 16))
            }.disabled(model.busy)
            Text("Access is linked to your Discord account. Your account must be approved to sign in.")
                .font(.footnote).foregroundStyle(.secondary)
        }.padding(28).background(Theme.background.ignoresSafeArea())
    }
}
