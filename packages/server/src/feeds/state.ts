// Read state per account (D-115), as SQL. Queries alias the account's item_states row as "st"; an
// item without one (it arrived while the account was starting to follow its source) is unread.
import { sql, type RawBuilder, type SqlBool } from "kysely";

export function unreadFor(): RawBuilder<SqlBool> {
  return sql<SqlBool>`coalesce(st.read, 0) = 0`;
}

export function readFor(): RawBuilder<number> {
  return sql<number>`coalesce(st.read, 0)`;
}
