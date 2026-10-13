import SwiftUI

enum Theme {
    static let purple = Color(red: 0.47, green: 0.32, blue: 0.86)
    static let background = Color(uiColor: .systemGroupedBackground)
}
extension ShelfStatus {
    var color: Color {
        switch self { case .available: return .green; case .back: return .yellow; case .out: return .red; case .unknown: return .gray }
    }
}

struct StockBadge: View {
    let status: ShelfStatus
    var body: some View {
        Label(status.title, systemImage: status.symbol).font(.caption.weight(.semibold))
            .foregroundStyle(.primary).padding(.horizontal, 9).padding(.vertical, 6)
            .background(status.color.opacity(0.18), in: Capsule())
    }
}

struct StorePin: View {
    let status: ShelfStatus
    let favorite: Bool
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Image(systemName: status.symbol).font(.system(size: 14, weight: .bold))
                .foregroundStyle(status == .back ? Color.black : Color.white)
                .frame(width: 34, height: 34).background(status.color, in: Circle())
                .overlay(Circle().stroke(.white, lineWidth: 3)).shadow(color: .black.opacity(0.15), radius: 3, y: 2)
            if favorite { Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(.white).padding(3).background(Theme.purple, in: Circle()).offset(x: 5, y: -4) }
        }
    }
}

struct StoreRow: View {
    let store: Store
    var products: Set<String>?
    var body: some View {
        HStack(spacing: 14) {
            StorePin(status: store.status(for: products), favorite: store.favorite)
            VStack(alignment: .leading, spacing: 5) {
                Text(store.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                Text(store.address.isEmpty ? "Address unavailable" : store.address).font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text(store.status(for: products).title)
                    if store.excluded { Text("Excluded").foregroundStyle(.orange) }
                    if store.coordinate == nil { Text("Map location pending") }
                }.font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if let miles = store.distanceMiles { Text(miles, format: .number.precision(.fractionLength(1))).font(.subheadline.monospacedDigit()) + Text(" mi").font(.caption) }
        }.padding(.vertical, 5).accessibilityElement(children: .combine)
    }
}

struct StatusBanner: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        if let warning = model.connectionWarning {
            Label(warning, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(.orange).padding(12)
        } else if model.monitoring?.enabled == false {
            Label("Live inventory is not enabled on this server yet.", systemImage: "pause.circle").font(.caption).foregroundStyle(.secondary).padding(12)
        } else if let delayed = model.monitoring?.delayedSearches, delayed > 0 {
            Label("Some inventory checks are delayed. Check observation times before traveling.", systemImage: "clock.badge.exclamationmark")
                .font(.caption).foregroundStyle(.orange).padding(12)
        }
    }
}

struct StoreDestination: Identifiable { let id: String }
