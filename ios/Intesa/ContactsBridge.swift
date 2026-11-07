import UIKit
import ContactsUI

/// Shows the system Contacts picker and returns the chosen people to the page.
/// The picker needs no Contacts permission of its own; the app only ever sees what was picked.
@MainActor
final class ContactsBridge: NSObject, @preconcurrency CNContactPickerDelegate {
    var onPicked: (([[String: String]]) -> Void)?
    var onCancelled: (() -> Void)?

    func present() {
        let picker = CNContactPickerViewController()
        picker.delegate = self
        picker.displayedPropertyKeys = [CNContactEmailAddressesKey, CNContactPhoneNumbersKey, CNContactOrganizationNameKey, CNContactJobTitleKey]
        guard let top = Self.topViewController() else { onCancelled?(); return }
        top.present(picker, animated: true)
    }

    // Implementing the multi-select callback is what turns multi-select on.
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contacts: [CNContact]) {
        onPicked?(contacts.map(Self.item))
    }

    func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        onCancelled?()
    }

    private static func item(_ c: CNContact) -> [String: String] {
        let name = CNContactFormatter.string(from: c, style: .fullName) ?? [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
        return [
            "name": name,
            "email": (c.emailAddresses.first?.value as String?) ?? "",
            "phone": c.phoneNumbers.first?.value.stringValue ?? "",
            "company": c.organizationName,
            "title": c.jobTitle,
        ]
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard var vc = scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
        while let next = vc.presentedViewController { vc = next }
        return vc
    }
}
