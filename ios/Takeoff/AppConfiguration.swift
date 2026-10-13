import Foundation

enum AppConfiguration {
    // Replace ONLY this URL with your Railway API's public HTTPS domain.
    // Do not add Discord secrets, DG cookies, or other server credentials here.
    static let apiBaseURL = "https://YOUR-BACKEND.up.railway.app"

    static func validatedURL() throws -> URL {
        guard var parts = URLComponents(string: apiBaseURL), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, !host.lowercased().contains("your-backend"),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw ClientError.message("Set your Railway HTTPS URL in AppConfiguration.swift, then run the app again.")
        }
        parts.path = ""; parts.host = host.lowercased()
        guard let url = parts.url else { throw ClientError.message("The Railway URL is invalid.") }
        return url
    }
}
