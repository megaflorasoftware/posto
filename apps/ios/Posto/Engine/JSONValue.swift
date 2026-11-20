import Foundation

/// Any JSON value. Frontmatter and metadata are schema-driven, so form values
/// travel between SwiftUI and the engine untyped and are read by field type.
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    subscript(index: Int) -> JSONValue? {
        if case .array(let array) = self, array.indices.contains(index) { return array[index] }
        return nil
    }

    /// The value at a frontmatter path of keys and list indices.
    func value(at path: [PathKey]) -> JSONValue? {
        var current: JSONValue? = self
        for key in path {
            switch key {
            case .key(let name): current = current?[name]
            case .index(let index): current = current?[index]
            }
        }
        return current
    }

    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    var stringValue: String? {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.rounded() == value && abs(value) < 1e15
                ? String(Int64(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        default: return nil
        }
    }

    /// The text a control shows, as FieldEditor's `asString` does.
    var displayString: String { stringValue ?? "" }

    var doubleValue: Double? {
        switch self {
        case .number(let value): return value
        case .string(let value): return Double(value)
        default: return nil
        }
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral
{
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    init(nilLiteral: ()) { self = .null }
}

extension JSONValue {
    init(_ string: String?) { self = string.map(JSONValue.string) ?? .null }

    init<T: Encodable>(encoding value: T) throws {
        let data = try JSONEncoder().encode(value)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    func decode<T: Decodable>(as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }

    func jsonString() -> String {
        (try? String(decoding: JSONEncoder().encode(self), as: UTF8.self)) ?? "null"
    }
}

/// One step of a frontmatter path: an object key or a list index.
enum PathKey: Hashable, Codable, Sendable, CustomStringConvertible {
    case key(String)
    case index(Int)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let index = try? container.decode(Int.self) {
            self = .index(index)
        } else {
            self = .key(try container.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .key(let key): try container.encode(key)
        case .index(let index): try container.encode(index)
        }
    }

    var description: String {
        switch self {
        case .key(let key): return key
        case .index(let index): return String(index)
        }
    }

    var json: JSONValue {
        switch self {
        case .key(let key): return .string(key)
        case .index(let index): return .number(Double(index))
        }
    }
}

extension Array where Element == PathKey {
    /// The engine's error-map key: segments joined with dots (`images.1.alt`).
    var dotted: String { map(\.description).joined(separator: ".") }
    var json: JSONValue { .array(map(\.json)) }
}
