"""Build an isolated offline preview from the current app sources."""
from pathlib import Path
import shutil

here = Path(__file__).resolve().parent
ios = here.parent.parent / "ios"
destination = ios / "build/main-page-headers-preview-src"
for name in ["IAPNotifications", "IAPNotifications.xcodeproj", "NotificationService"]:
    shutil.copytree(ios / name, destination / name, dirs_exist_ok=True)

project = destination / "IAPNotifications.xcodeproj/project.pbxproj"
project.write_text(project.read_text().replace("com.kozr.quest", "com.kozr.quest.headerspreview"))
app = destination / "IAPNotifications/IAPNotificationsApp.swift"
source = app.read_text()
end = source.index("\n@MainActor\nfinal class PushDelegate")
app.write_text((here / "PreviewApp.swift").read_text() + source[end:])
print(destination)
