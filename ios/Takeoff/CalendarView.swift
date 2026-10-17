import SwiftUI
import PhotosUI
import ImageIO
import UIKit

struct CalendarView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var month = Calendar.current.dateInterval(of: .month, for: Date())!.start
    @State private var selectedDay = Date()
    @State private var selected: CalendarEntry?
    @State private var selectedStore: StoreDestination?
    @State private var showNew = false
    @State private var showOptions = false
    @State private var showPredictions = false
    @State private var showAllPredictions = false
    private let calendar = Calendar.current
    private var window: DateInterval {
        let weekday = calendar.component(.weekday, from: month)
        let offset = (weekday - calendar.firstWeekday + 7) % 7
        let start = calendar.date(byAdding: .day, value: -offset, to: month)!
        return DateInterval(start: start, end: calendar.date(byAdding: .day, value: 42, to: start)!)
    }
    private var days: [Date] { (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: window.start) } }
    private var dayEvents: [CalendarEntry] { model.calendarEntries.filter { $0.overlaps(selectedDay) } }
    private var predictions: [CalendarPrediction] {
        model.calendarPredictions.filter { calendar.isDate($0.expectedAt, inSameDayAs: selectedDay) && $0.expectedAt >= Date() }
    }
    private var monthOffset: Int { calendar.dateComponents([.month], from: calendar.dateInterval(of: .month, for: Date())!.start, to: month).month ?? 0 }
    var body: some View {
        NavigationStack {
            List {
                if model.member?.capabilities.calendar != true {
                    ContentUnavailableView("Update Railway", systemImage: "calendar",
                        description: Text("Deploy the calendar backend, then sign out and back in to enable the calendar."))
                } else {
                    Section { monthGrid }.listRowBackground(Color.clear)
                    if let error = model.calendarError {
                        Section { Label(error, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                            Button("Try again") { Task { await reload() } } }
                    }
                    Section(selectedDay.formatted(date: .complete, time: .omitted)) {
                        if model.calendarLoading && dayEvents.isEmpty { ProgressView("Loading events…") }
                        else if dayEvents.isEmpty { Text("No events for this day.").foregroundStyle(.secondary) }
                        ForEach(dayEvents, id: \.occurrenceId) { event in
                            Button { selected = event } label: { CalendarEventRow(event: event) }.buttonStyle(.plain)
                        }
                    }
                    if model.calendarOptions.showPredictions && !predictions.isEmpty {
                        Section {
                            DisclosureGroup(isExpanded: $showPredictions) {
                                ForEach(Array(predictions.prefix(showAllPredictions ? predictions.count : 3))) { prediction in
                                    Button { selectedStore = StoreDestination(id: prediction.storeId) } label: {
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text(prediction.address).font(.headline).foregroundStyle(.primary)
                                            Text(prediction.titles.joined(separator: ", ")).font(.subheadline).foregroundStyle(.secondary)
                                            Text("Around \(prediction.expectedAt, format: .dateTime.hour().minute()) · \(prediction.confidence.capitalized) confidence")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }.padding(.vertical, 4)
                                    }
                                }
                                if predictions.count > 3 {
                                    Button(showAllPredictions ? "Show fewer" : "Show all \(predictions.count) stores") { showAllPredictions.toggle() }
                                }
                            } label: { Label("DG predictions · \(predictions.count)", systemImage: "sparkles") }
                        } footer: {
                            Text("Estimates for stock already detected in back, grouped by store. These are not confirmed restock events. Times use your iPhone's timezone.")
                        }
                    }
                }
            }
            .navigationTitle("Calendar")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Today") {
                        selectedDay = Date(); month = calendar.dateInterval(of: .month, for: Date())!.start
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showOptions = true } label: { Image(systemName: "line.3.horizontal.decrease") }.accessibilityLabel("Calendar options")
                    Button { showNew = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add event")
                }
            }
            .disabled(model.member?.capabilities.calendar != true)
            .sheet(isPresented: $showNew) { CalendarEditor(event: nil, day: selectedDay).environmentObject(model) }
            .sheet(item: $selected) { event in CalendarDetail(event: event).environmentObject(model) }
            .sheet(isPresented: $showOptions) { CalendarOptionsView(options: model.calendarOptions).environmentObject(model) }
            .sheet(item: $selectedStore) { value in NavigationStack { StoreDetailView(storeID: value.id) }.environmentObject(model) }
            .refreshable { await reload() }
            .task(id: month) {
                while !Task.isCancelled {
                    if scenePhase == .active { await reload() }
                    do { try await Task.sleep(for: .seconds(60)) } catch { break }
                }
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await reload() } } }
        }
    }
    private func reload() async { await model.loadCalendar(from: window.start, to: window.end) }
    private func moveMonth(_ amount: Int) {
        month = calendar.date(byAdding: .month, value: amount, to: month)!
        selectedDay = month; showAllPredictions = false
    }
    private var monthGrid: some View {
        VStack(spacing: 14) {
            HStack {
                Button { moveMonth(-1) } label: { Image(systemName: "chevron.left") }.disabled(monthOffset <= -11).accessibilityLabel("Previous month")
                Spacer(); Text(month, format: .dateTime.month(.wide).year()).font(.headline); Spacer()
                Button { moveMonth(1) } label: { Image(systemName: "chevron.right") }.disabled(monthOffset >= 11).accessibilityLabel("Next month")
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 6) {
                ForEach(0..<7, id: \.self) { index in
                    Text(calendar.veryShortStandaloneWeekdaySymbols[(calendar.firstWeekday - 1 + index) % 7])
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(days, id: \.self) { day in
                    let chosen = calendar.isDate(day, inSameDayAs: selectedDay)
                    let sameMonth = calendar.isDate(day, equalTo: month, toGranularity: .month)
                    let hasEvent = model.calendarEntries.contains { $0.overlaps(day) }
                    Button { selectedDay = day; showAllPredictions = false } label: {
                        VStack(spacing: 3) {
                            Text("\(calendar.component(.day, from: day))").font(.subheadline.weight(calendar.isDateInToday(day) ? .bold : .regular))
                            Circle().fill(hasEvent ? (chosen ? Color.white : Theme.purple) : Color.clear).frame(width: 4, height: 4)
                        }.frame(maxWidth: .infinity, minHeight: 40)
                            .foregroundStyle(chosen ? Color.white : sameMonth ? Color.primary : Color.secondary)
                            .background(chosen ? Theme.purple : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                    }.buttonStyle(.plain).accessibilityLabel(day.formatted(date: .complete, time: .omitted) + (hasEvent ? ", has events" : ""))
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                }
            }
        }.padding(.vertical, 4)
    }
}

private struct CalendarEventRow: View {
    let event: CalendarEntry
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 3).fill(event.isShared ? Theme.purple : Color.blue).frame(width: 4)
            VStack(alignment: .leading, spacing: 5) {
                Text(event.title).font(.headline)
                Text(event.startsAt, format: .dateTime.hour().minute()).font(.subheadline)
                if !event.location.isEmpty { Text(event.location).font(.subheadline).foregroundStyle(.secondary) }
                HStack(spacing: 6) {
                    Text(event.sourceTitle)
                    if !event.retailer.isEmpty { Text("· " + event.retailer) }
                    if event.hasImage { Image(systemName: "photo") }
                    if event.recurrence == "weekly" { Image(systemName: "repeat") }
                }.font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }.padding(.vertical, 6).fixedSize(horizontal: false, vertical: true)
    }
}

private struct CalendarDetail: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let event: CalendarEntry
    @State private var editing = false
    @State private var deleting = false
    var body: some View {
        NavigationStack {
            List {
                if event.hasImage { CalendarPhoto(event: event).listRowInsets(EdgeInsets()) }
                Section {
                    Text(event.title).font(.title2.bold())
                    Label(event.sourceTitle, systemImage: event.isShared ? "person.badge.shield.checkmark" : "lock")
                        .font(.caption).foregroundStyle(.secondary)
                    if !event.retailer.isEmpty { Text(event.retailer).font(.headline) }
                    Text(event.startsAt.formatted(date: .abbreviated, time: .shortened) + " – " + event.endsAt.formatted(date: .abbreviated, time: .shortened))
                    if event.recurrence == "weekly" { Label("Repeats weekly", systemImage: "repeat") }
                    if !event.location.isEmpty { Label(event.location, systemImage: "mappin.and.ellipse") }
                    if let zip = event.zip { Text("Area: ZIP \(zip)") }
                    else if event.isShared { Text("Shared with all members").font(.caption).foregroundStyle(.secondary) }
                } footer: { Text("Times are shown in your iPhone's timezone.") }
                if !event.description.isEmpty { Section("Details") { Text(event.description).textSelection(.enabled) } }
                if event.canEdit {
                    Section {
                        Button(event.recurrence == "weekly" ? "Edit series" : "Edit event") { editing = true }
                        Button(event.recurrence == "weekly" ? "Delete series" : "Delete event", role: .destructive) { deleting = true }
                    }.disabled(model.calendarSaving)
                }
            }.navigationTitle("Event").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .sheet(isPresented: $editing) { CalendarEditor(event: event, day: event.seriesStartsAt, onSaved: { dismiss() }).environmentObject(model) }
                .confirmationDialog(event.recurrence == "weekly" ? "Delete this entire series?" : "Delete this event?", isPresented: $deleting, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) { Task { if await model.deleteCalendar(event) { dismiss() } } }
                }
        }
    }
}

private struct CalendarPhoto: View {
    @EnvironmentObject private var model: AppModel
    let event: CalendarEntry
    @State private var picture: UIImage?
    @State private var failed = false
    @State private var attempt = 0
    var body: some View {
        Group {
            if let picture { Image(uiImage: picture).resizable().scaledToFit().frame(maxWidth: .infinity) }
            else if failed { Button("Retry image") { attempt += 1 }.frame(maxWidth: .infinity, minHeight: 120) }
            else { ProgressView("Loading image…").frame(maxWidth: .infinity, minHeight: 120) }
        }.task(id: "\(event.id):\(event.version):\(attempt)") {
            picture = nil; failed = false
            do {
                let data = try await model.calendarImage(for: event)
                try Task.checkCancellation()
                picture = UIImage(data: data); failed = picture == nil
            } catch {
                if !(error is CancellationError) {
                    failed = true
                    if let apiError = error as? APIError, apiError.endsSession { await model.report(error) }
                }
            }
        }
    }
}

private struct CalendarOptionsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State var options: CalendarOptions
    var body: some View {
        NavigationStack {
            Form {
                Section("Events") {
                    Toggle("Moderator events", isOn: $options.showModerator)
                    Toggle("My private events", isOn: $options.showPrivate)
                }
                Section {
                    Toggle("Show DG predictions", isOn: $options.showPredictions)
                    if options.showPredictions {
                        Picker("Stores", selection: $options.favoritesOnly) {
                            Text("Favorites only").tag(true)
                            Text("All nearby stores").tag(false)
                        }
                    }
                } header: { Text("DG predictions") } footer: {
                    Text("Predictions stay in a separate, collapsed section. They use followed products in your saved ZIP area and hide excluded stores. Changing this filter does not start new monitoring.")
                }
            }.navigationTitle("Calendar options").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.calendarSaving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { if await model.saveCalendarOptions(options) { dismiss() } } }.disabled(model.calendarSaving)
                    }
                }
                .interactiveDismissDisabled(model.calendarSaving)
        }
    }
}

private struct CalendarEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let event: CalendarEntry?
    var onSaved: (() -> Void)?
    @State private var visibility: String
    @State private var title: String
    @State private var details: String
    @State private var retailer: String
    @State private var location: String
    @State private var zip: String
    @State private var starts: Date
    @State private var ends: Date
    @State private var weekly: Bool
    @State private var repeatUntil: Date
    @State private var photo: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var removeImage = false
    @State private var imageLoading = false
    @State private var imageError: String?
    private var timezone: TimeZone { TimeZone(identifier: event?.timezone ?? TimeZone.current.identifier) ?? .current }
    private var valid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.count <= 120 && details.count <= 3000 &&
        retailer.count <= 60 && location.count <= 250 && (zip.isEmpty || zip.count == 5 && zip.allSatisfy(\.isNumber)) &&
        ends > starts && ends.timeIntervalSince(starts) <= 7 * 86400 && (!weekly || repeatUntil >= starts) && !imageLoading
    }
    init(event: CalendarEntry?, day: Date, onSaved: (() -> Void)? = nil) {
        self.event = event; self.onSaved = onSaved
        let start = event?.seriesStartsAt ?? Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: day)!
        _visibility = State(initialValue: event?.source ?? "private")
        _title = State(initialValue: event?.title ?? ""); _details = State(initialValue: event?.description ?? "")
        _retailer = State(initialValue: event?.retailer ?? ""); _location = State(initialValue: event?.location ?? "")
        _zip = State(initialValue: event?.zip ?? ""); _starts = State(initialValue: start)
        _ends = State(initialValue: event?.seriesEndsAt ?? start.addingTimeInterval(3600))
        _weekly = State(initialValue: event?.recurrence == "weekly")
        _repeatUntil = State(initialValue: event?.repeatUntil ?? start.addingTimeInterval(28 * 86400))
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if event == nil && model.member?.isModerator == true {
                        Picker("Who can see this?", selection: $visibility) {
                            Text("Only me").tag("private"); Text("Members · moderator post").tag("moderator")
                        }
                    } else { Label(visibility == "moderator" ? "Moderator event" : "Only you", systemImage: visibility == "moderator" ? "person.2" : "lock") }
                    TextField("Event title", text: $title)
                    TextField("Retailer, e.g. Target", text: $retailer)
                    TextField("Store or location", text: $location)
                    TextField(visibility == "moderator" ? "Area ZIP (blank = all members)" : "ZIP (optional)", text: $zip).keyboardType(.numberPad)
                } footer: {
                    if visibility == "moderator" { Text("An area ZIP shares this post with members whose saved ZIP centers are within 25 miles. Leave it blank for all members.") }
                    else { Text("Private events are visible only to you, including when a moderator views the calendar.") }
                }
                Section("When") {
                    DatePicker("Starts", selection: $starts)
                    DatePicker("Ends", selection: $ends)
                    Text("Event time: \(timezone.identifier.replacingOccurrences(of: "_", with: " "))").font(.caption).foregroundStyle(.secondary)
                    Toggle("Repeat weekly", isOn: $weekly)
                    if weekly {
                        DatePicker("Repeat through", selection: $repeatUntil, in: starts...starts.addingTimeInterval(182 * 86400), displayedComponents: .date)
                        Text("Editing or deleting affects the whole series. Weekly events keep the same local time through daylight saving changes.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.environment(\.timeZone, timezone)
                Section("Details") { TextField("What should members know?", text: $details, axis: .vertical).lineLimit(5...12) }
                if visibility == "moderator" {
                    Section("Image") {
                        if let imageData, let image = UIImage(data: imageData) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 240) }
                        else if let event, event.hasImage && !removeImage { CalendarPhoto(event: event) }
                        PhotosPicker(selection: $photo, matching: .images, preferredItemEncoding: .compatible) {
                            Label(imageData != nil || event?.hasImage == true && !removeImage ? "Replace image" : "Choose image", systemImage: "photo")
                        }.disabled(imageLoading)
                        if imageLoading { ProgressView("Preparing image…") }
                        if let imageError { Text(imageError).foregroundStyle(.red).font(.caption) }
                        if imageData != nil || event?.hasImage == true && !removeImage {
                            Button("Remove image", role: .destructive) { imageData = nil; photo = nil; removeImage = true }
                        }
                    }
                }
            }.navigationTitle(event == nil ? "New event" : "Edit event").navigationBarTitleDisplayMode(.inline)
                .disabled(model.calendarSaving)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.calendarSaving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.calendarSaving ? "Saving…" : "Save") { Task { await save() } }.disabled(!valid || model.calendarSaving)
                    }
                }
                .interactiveDismissDisabled(model.calendarSaving)
                .onChange(of: starts) { old, new in
                    if ends <= new { ends = new.addingTimeInterval(max(60, ends.timeIntervalSince(old))) }
                    repeatUntil = min(max(repeatUntil, new), new.addingTimeInterval(182 * 86400))
                }
                .onChange(of: visibility) { _, _ in photo = nil; imageData = nil; imageError = nil; removeImage = false }
                .task(id: photo) { await preparePhoto() }
        }
    }
    private func save() async {
        var localCalendar = Calendar.current; localCalendar.timeZone = timezone
        let until = localCalendar.date(byAdding: .day, value: 1, to: localCalendar.startOfDay(for: repeatUntil))!.addingTimeInterval(-1)
        let input = CalendarWrite(version: event?.version ?? 0, visibility: visibility, title: title, description: details,
            retailer: retailer, location: location, zip: zip.isEmpty ? nil : zip, startsAt: starts, endsAt: ends,
            timezone: timezone.identifier, recurrence: weekly ? "weekly" : "none", repeatUntil: weekly ? until : nil,
            imageBase64: visibility == "moderator" ? imageData?.base64EncodedString() : nil, removeImage: removeImage)
        if await model.saveCalendar(id: event?.id, input: input) { dismiss(); onSaved?() }
    }
    private func preparePhoto() async {
        guard let selected = photo else { return }
        imageLoading = true; imageError = nil
        defer { imageLoading = false }
        do {
            guard let bytes = try await selected.loadTransferable(type: Data.self), bytes.count <= 30_000_000 else {
                throw ClientError.message("Choose an image smaller than 30 MB.")
            }
            try Task.checkCancellation()
            guard photo == selected, visibility == "moderator" else { return }
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1200,
                kCGImageSourceShouldCacheImmediately: true]
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
                  let data = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.8), data.count <= 1_500_000 else {
                throw ClientError.message("This image could not be prepared. Try another photo.")
            }
            imageData = data; removeImage = false
        } catch { if !(error is CancellationError) { imageError = error.localizedDescription } }
    }
}
