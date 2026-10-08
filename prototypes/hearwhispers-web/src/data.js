export const exampleProduct = { id: "hearwhispers", name: "HearWhispers", website: "", description: "Public conversation discovery for product makers.", example: true };

// Real historical public discussions, not live search results.
export const conversations = [
  {
    id: "first-users", productId: "hearwhispers",
    title: "IndieHackers, How Did You Get Your First REAL Users?",
    community: "r/indiehackers", author: "u/ManagerCompetitive77", date: "March 5, 2025",
    url: "https://www.reddit.com/r/indiehackers/comments/1j4b8kr/indiehackers_how_did_you_get_your_first_real_users/",
    summary: "The author is prototyping a startup and looking for practical ways to reach users beyond friends, family, and launch traffic.",
    quote: "What practical and actionable steps worked for you?",
    relevance: "Relevant to conversation discovery. Buying intent is not established.",
  },
  {
    id: "finding-distribution", productId: "hearwhispers",
    title: "94 downloads in 2 weeks. Is it worth the grind? Feeling completely exhausted",
    community: "r/SideProject", author: "u/UsualCommon2095", date: "March 17, 2026",
    url: "https://www.reddit.com/r/SideProject/comments/1rw6iuf/94_downloads_in_2_weeks_is_it_worth_the_grind/",
    summary: "An independent iOS developer describes the effort of finding places to discuss their product after launch.",
    quote: "Every single day is a grind of trying to figure out where to talk about it, and obsessively refreshing App Store Connect.",
    relevance: "The author describes difficulty finding relevant places to talk about a product. Read the current thread before deciding whether a response would help.",
  },
];
