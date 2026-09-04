import Foundation

/// This is a short-lived pairing challenge, never an account/session bearer token.
struct PairingCredentials: Encodable, Equatable {
    let id: String
    let token: String
}

struct PairingLink: Equatable {
    let credentials: PairingCredentials
    let serverOrigin: String

    static func parse(_ input: String, signedInServer: URL, allowLocalHTTP: Bool) throws -> PairingLink {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.utf8.count <= 2_048,
              let parts = URLComponents(string: raw),
              parts.scheme?.lowercased() == "iapnotifications",
              parts.host?.lowercased() == "pair",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.path.isEmpty, parts.fragment == nil,
              let items = parts.queryItems, items.count == 4,
              Set(items.map(\.name)) == Set(["v", "server", "id", "token"])
        else { throw ClientError.message("This is not a valid desktop sign-in QR link. Scan the QR code on your computer, or paste its full link—not the six-digit matching code.") }

        // The exact item count and key set also reject duplicate query parameters.
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard values["v"] == "1", let server = values["server"],
              let id = values["id"], let token = values["token"],
              isBase64URL(id, count: 22), isBase64URL(token, count: 43)
        else { throw ClientError.message("This QR link is invalid or uses an unsupported version. Request a new code on your computer.") }

        let scannedURL = try ServerAddress.validate(server, allowLocalHTTP: allowLocalHTTP)
        let scannedOrigin = canonicalOrigin(scannedURL)
        guard scannedOrigin == canonicalOrigin(signedInServer) else {
            throw ClientError.message("This QR code belongs to a different server. Open the same server on your computer. Your phone will not change servers or send your session to the QR code's address.")
        }
        return PairingLink(credentials: .init(id: id, token: token), serverOrigin: scannedOrigin)
    }

    static func canonicalOrigin(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "" }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) {
            parts.port = nil
        }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.string ?? ""
    }

    private static func isBase64URL(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

struct PairingInspectionResponse: Decodable {
    let pairing: PairingReview
}

struct PairingReview: Decodable, Identifiable {
    let id: String
    let code: String
    let expiresAt: String
    let publicUrl: String
    let browserName: String

    var expiration: Date? { Timestamp.date(expiresAt) }

    func validate(for link: PairingLink, allowLocalHTTP: Bool, now: Date = .now) throws {
        let serverURL = try ServerAddress.validate(publicUrl, allowLocalHTTP: allowLocalHTTP)
        guard id == link.credentials.id,
              code.utf8.count == 6, code.utf8.allSatisfy({ (48...57).contains($0) }),
              PairingLink.canonicalOrigin(serverURL) == link.serverOrigin,
              !browserName.isEmpty, browserName.count <= 200,
              let expiration
        else { throw ClientError.message("The server returned an invalid sign-in request. Close it and scan a new QR code.") }
        guard expiration > now else { throw ClientError.message("This sign-in request expired. Generate a new QR code on your computer.") }
    }
}
