import Foundation

enum LeadJournalExamples {
    @MainActor static func halloweenSession() -> LeadJournalSession {
        let post = "Does anyone know where to find a list of every single Halloween Sonny angel out?"
        let lead = LeadItem(id: "sample-lead-halloween", appId: "sample-blindbox", postId: "sample-halloween",
                            community: "SonnyAngel", title: post, excerpt: post, createdAt: "2026-09-24T00:00:00Z",
                            whyItFits: "Browse series and build a wishlist.")
        return LeadJournalSession(lead: lead, appName: "Blind Box Tracker", revision: nil, plan: halloween)
    }

    static let halloween = LeadReplyPlan(title: "Find the Halloween Sonny Angels",
        objective: "Help a collector find a list of Halloween figures.", replies: [
            LeadReplyOption(id: "resource", title: "Start with the official list",
                summary: "Look through the Sonny Angel releases by year.",
                body: "A Halloween master list would be so handy. I’d start with the limited-series section on the Sonny Angel website and look through the releases by year. Blind Box Tracker is another option for browsing series and saving figures to your wishlist. Handy for keeping track as you build your list."),
            LeadReplyOption(id: "light", title: "Build a visual checklist", summary: "Save photos and separate owned from wanted.",
                body: "A Halloween checklist would make this easier. I’d save pictures of the ones you’re after and split them into owned and still looking. A notes checklist works, or something like Blind Box Tracker if you prefer a wishlist on your phone. Makes it easier to see what’s missing.")
        ])

    static func plan(for lead: LeadItem, appName: String) -> LeadReplyPlan {
        if lead.appId == "demo-orbit" {
            return LeadReplyPlan(title: "Make room for a daily entry", objective: "Help someone start a journal they can easily revisit.", replies: [
                LeadReplyOption(id: "resource", title: "Start with one sentence", summary: "Keep each entry short enough to finish every day.",
                    body: "A few thoughts each day sounds like a manageable place to start. You could use a notebook and give each entry a date and one sentence about the day. \(appName) is another option for writing entries and revisiting them later. Keeping them short makes it easier to keep going."),
                LeadReplyOption(id: "light", title: "Use the same daily prompt", summary: "Choose one question to return to each evening.",
                    body: "Being able to look back is such a useful part of keeping a journal. Try a simple prompt like one thing you want to remember, and write a couple of lines each evening. A notes app works, or something like \(appName) if you prefer a separate journal. Having a starting point saves staring at a blank page.")])
        }
        return LeadReplyPlan(title: "Find a starting point for studying", objective: "Help someone begin a manageable study session.", replies: [
            LeadReplyOption(id: "resource", title: "Start with a short work block", summary: "Choose one small task and set a ten-minute timer.",
                body: "Getting started sounds like the tricky part here. I’d pick one small task and set a phone timer for ten minutes, then take a short break. \(appName) is another option for timing work sessions and breaks. A small first block gives you a clear place to begin."),
            LeadReplyOption(id: "light", title: "Write the next step first", summary: "Decide what to do before starting the clock.",
                body: "A clear start and a break can make a study session feel more manageable. Try writing down the next thing you’ll do, like reading two pages, before starting your timer. Your phone’s clock works, or something like \(appName). Then you can spend the session on the task instead of deciding where to start.")])
    }
}
