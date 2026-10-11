import { VERSION } from "../version.js";

/**
 * The app identifies itself honestly instead of pretending to be a browser (DECISIONS D-037),
 * so site owners can see what it is and robots.txt rules for "*" apply as written.
 */
export const USER_AGENT = `Mozilla/5.0 (compatible; ForumAggregator/${VERSION}; personal feed reader; +https://github.com/AlexStapleton/ForumAggregator)`;
