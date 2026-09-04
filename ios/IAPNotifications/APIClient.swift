import Foundation
import Security

enum ClientError: LocalizedError {
    case message(String)
    case server(status: Int, message: String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .message(let message), .server(_, let message): return message
        case .invalidResponse: return "The server returned an unexpected response. Check the server address and try again."
        }
    }

    var isUnauthorized: Bool {
        if case .server(status: 401, _) = self { return true }
        return false
    }

    var isNotFound: Bool {
        if case .server(status: 404, _) = self { return true }
        return false
    }
}

enum ServerAddress {
    static func validate(_ input: String, allowLocalHTTP: Bool) throws -> URL {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: trimmed),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/"
        else { throw ClientError.message("Enter only the server origin, for example https://alerts.example.com. Do not include a path, password, or query.") }

        if scheme != "https" {
            #if DEBUG
            guard scheme == "http", allowLocalHTTP, isLocalHost(host) else {
                throw ClientError.message("Use HTTPS. Debug builds allow HTTP only for an explicitly enabled local development server.")
            }
            #else
            throw ClientError.message("This build requires an HTTPS server address.")
            #endif
        }
        parts.scheme = scheme
        parts.host = host
        parts.path = ""
        guard let url = parts.url else { throw ClientError.message("Enter a valid server address.") }
        return url
    }

    static func isLocalHost(_ host: String) -> Bool {
        let normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if normalized == "localhost" || normalized == "::1" || normalized.hasSuffix(".local") { return true }
        let octets = normalized.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, normalized.split(separator: ".").count == 4,
              octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 127 || octets[0] == 10 ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && (16...31).contains(octets[1]))
    }
}

/// No cookies or redirects: bearer credentials never migrate to a redirected origin.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct APIClient {
    let baseURL: URL
    let token: String?

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }()

    func request<Response: Decodable>(_ path: String, method: String = "GET",
                                      query: [URLQueryItem] = [], body: Data? = nil) async throws -> Response {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw ClientError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("IAPNotifications-iOS/0.1", forHTTPHeaderField: "User-Agent")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await Self.session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200...299).contains(response.statusCode) else {
            let error = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            let fallback = (300...399).contains(response.statusCode)
                ? "The server redirected this request. Enter the final HTTPS server address; redirects are disabled to protect your session."
                : "Server request failed (HTTP \(response.statusCode)). Try again."
            throw ClientError.server(status: response.statusCode, message: error?.error ?? fallback)
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw ClientError.invalidResponse }
    }

    func send<Body: Encodable, Response: Decodable>(_ path: String, method: String = "POST", body: Body) async throws -> Response {
        try await request(path, method: method, body: JSONEncoder().encode(body))
    }
}

/// The bearer token and its origin are one atomic Keychain record, never UserDefaults.
enum KeychainStore {
    private static let service = "com.example.IAPNotifications.session"

    static func read<Value: Decodable>(_ type: Value.Type, key: String) throws -> Value? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw keychainError(status) }
        return try JSONDecoder().decode(type, from: data)
    }

    static func write<Value: Encodable>(_ value: Value, key: String) throws {
        let data = try JSONEncoder().encode(value)
        let query = baseQuery(key)
        let updates: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw keychainError(status) }
    }

    static func remove(_ key: String) throws {
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
    }

    private static func baseQuery(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    private static func keychainError(_ status: OSStatus) -> ClientError {
        .message("Secure storage is unavailable (\(status)). Unlock your device and try again.")
    }
}
