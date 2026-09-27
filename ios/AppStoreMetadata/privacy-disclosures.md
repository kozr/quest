# Tavern App Privacy answer sheet

Reviewed September 26, 2026 against current source. The seven categories below were previously published September 13; the updated published questionnaire has NOT been reverified in this pass. The meanings now include Marketing subscriptions, editable app profiles, public-source research, and AI processing. Local disclosure changes do not publish App Store privacy labels.

Select **Yes, we collect data**. The public offline demo does not create an account, but the live service collects the following data. Do not select “Data Not Collected.”

| Apple data type | Evidence and purpose | Linked to the user | Tracking |
| --- | --- | --- | --- |
| Email Address | Apple/Firebase account email or private relay address; authentication and account support | Yes | No |
| User ID | Firebase account ID, Apple provider ID, and service sessions; authentication, access control, and fraud prevention | Yes | No |
| Device ID | APNs token and registered-device record; deliver selected notifications and stop delivery to disconnected devices | Yes | No |
| Purchase History | Connected-app transaction/product IDs, amounts and events, plus Tavern Marketing purchase IDs, subscription status and selected app coverage; deliver the service and verify entitlement | Yes, linked to the developer account that connected the app | No |
| Other User Content | Connected-app names/identifiers, forwarding destinations, confirmed profile text, keywords/communities, saved or dismissed research choices, and generated research/replies; operate the service | Yes | No |
| Customer Support | Information a user emails to support; resolve their request | Yes | No |
| Other Diagnostic Data | Delivery attempts/outcomes and operational/security records; troubleshoot delivery and protect the service | Yes, where records identify the account/app/device | No |

Use **App Functionality** for the purposes above. Questline does not use the data for advertising, marketing, third-party advertising, or cross-company tracking. There is no analytics SDK in the native app. Provider request logs are used for service operation and security.

Tavern offers Marketing auto-renewable subscriptions using StoreKit in addition to processing purchase events for connected apps. Apple handles payment; Tavern does not receive payment card or bank information. Camera frames stay on the phone for QR scanning and are not collected. The app does not request contacts, location, microphone, photo-library, or tracking access. Apple private-relay email still counts as collected email.

The account’s developer may choose to forward Apple’s original signed payload to their own server or service. That destination may receive additional Apple transaction fields; the public privacy policy explains this user-configured sharing. No raw Apple/Firebase sign-in credentials or supplied App Store Server API private keys are stored in the application database.

The native target uses Apple system frameworks and its own server API, with no bundled Firebase or other third-party SDK. Source inspection found app-local UserDefaults/AppStorage for setup progress, display currency, and time zone. PrivacyInfo.xcprivacy declares NSPrivacyAccessedAPICategoryUserDefaults with CA92.1 and the seven collected categories above. No file-timestamp, disk-capacity, system-boot-time, or active-keyboard required-reason API use was found. Reassess manifests and disclosures when adding SDKs or new data collection.

Before submission, compare the final published questionnaire with the public policy and current hosting practices. This answer sheet does not itself publish an App Store privacy label.

References: [Apple privacy data definitions](https://developer.apple.com/app-store/app-privacy-details/), [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy), [Privacy manifests](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk).

## AI and public-source data
OpenAI requests use public App Store metadata, the confirmed app profile, and public source evidence. Market/People evidence may contain public author names, handles, profile URLs, and post images. Public does not mean anonymous. The payload allowlist excludes database account/app linkage, authentication, device tokens, sales and billing records. Free-form text can still contain personal information. The existing Other User Content category must be reviewed alongside Apple’s data definitions and the final published questionnaire. Do not declare “no personal data sent to AI.”

Current profile confirmation explicitly describes sharing with OpenAI. This is not a server-side consent migration for existing profiles, and users cannot consent on behalf of public authors. Any legally required author permission/source rights remain an operator review item. A material change to personal-data processing would need a real, versioned server-enforced permission flow, including existing users and scheduled jobs—not just policy text.
