import CoreLocation
import Foundation
import Combine

@MainActor
final class LocationPicker: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var busy = false
    @Published var zip: String?
    @Published var error: String?
    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var timeout: Task<Void, Never>?
    override init() { super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyKilometer }
    func chooseZIP() {
        guard !busy else { return }; busy = true; error = nil; zip = nil
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            self?.fail("Location took too long. You can enter a ZIP manually.")
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        default: fail("Location access is off. Enter your ZIP manually or enable location in iPhone Settings.")
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard busy else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        case .denied, .restricted: fail("You can enter your ZIP manually.")
        default: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard busy, let location = locations.last else { return }
        manager.stopUpdatingLocation()
        Task {
            do {
                let places = try await geocoder.reverseGeocodeLocation(location)
                guard let place = places.first, place.isoCountryCode == "US", let postal = place.postalCode else {
                    fail("A US ZIP could not be found here. Please enter it manually."); return
                }
                let value = String(postal.prefix(5))
                guard value.count == 5, value.allSatisfy(\.isNumber), busy else {
                    fail("A five-digit ZIP could not be found. Please enter it manually."); return
                }
                timeout?.cancel(); zip = value; busy = false
            } catch { fail("Could not resolve a ZIP here. Please enter it manually.") }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { fail("Could not get your location. Please enter a ZIP manually.") }
    private func fail(_ message: String) {
        timeout?.cancel(); manager.stopUpdatingLocation(); geocoder.cancelGeocode(); busy = false; error = message
    }
    func cancel() { timeout?.cancel(); manager.stopUpdatingLocation(); geocoder.cancelGeocode(); busy = false }
}
