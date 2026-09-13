# Questline App Privacy answer sheet

Prepared September 10, 2026 from the native client, API, database, delivery workers, and hosting configuration. Completed and **published September 13, 2026** after the owner's explicit confirmation of Apple's accuracy/update declaration. All seven data types below are saved with App Functionality, linked to the user, and no tracking. App Store Connect verified publication by Nicholas Wong.

Select **Yes, we collect data**. The public offline demo does not create an account, but the live service collects the following data. Do not select “Data Not Collected.”

| Apple data type | Evidence and purpose | Linked to the user | Tracking |
| --- | --- | --- | --- |
| Email Address | Apple/Firebase account email or private relay address; authentication and account support | Yes | No |
| User ID | Firebase account ID, Apple provider ID, and service sessions; authentication, access control, and fraud prevention | Yes | No |
| Device ID | APNs token and registered-device record; deliver selected notifications and stop delivery to disconnected devices | Yes | No |
| Purchase History | Connected apps’ transaction/product IDs, event types, amounts, currencies, and timestamps; display activity, deduplicate, and deliver/forward notifications | Yes, linked to the developer account that connected the app | No |
| Other User Content | Connected-app names/identifiers and configured forwarding destinations; connect and operate the service | Yes | No |
| Customer Support | Information a user emails to support; resolve their request | Yes | No |
| Other Diagnostic Data | Delivery attempts/outcomes and operational/security records; troubleshoot delivery and protect the service | Yes, where records identify the account/app/device | No |

Use **App Functionality** for the purposes above. Questline does not use the data for advertising, marketing, third-party advertising, or cross-company tracking. There is no analytics SDK in the native app. Provider request logs are used for service operation and security.

Purchase records belong to the developer’s connected apps; Questline does not sell IAP products in this version or receive payment card/bank information. Camera frames stay on the phone for QR scanning and are not collected. The app does not request contacts, location, microphone, photo-library, or tracking access. Apple private-relay email still counts as collected email.

The account’s developer may choose to forward Apple’s original signed payload to their own server or service. That destination may receive additional Apple transaction fields; the public privacy policy explains this user-configured sharing. No raw Apple/Firebase sign-in credentials or supplied App Store Server API private keys are stored in the application database.

The native target uses Apple system frameworks and its own server API, with no bundled Firebase or other third-party SDK. Source inspection found no UserDefaults, file-timestamp, disk-capacity, system-boot-time, or active-keyboard required-reason API use. Reassess manifests and disclosures when adding SDKs or new data collection.

Before submission, compare the final published questionnaire with the public policy and current hosting practices. This answer sheet does not itself publish an App Store privacy label.

References: [Apple privacy data definitions](https://developer.apple.com/app-store/app-privacy-details/), [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy), [Privacy manifests](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk).
