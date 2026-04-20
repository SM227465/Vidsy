// Strip a trailing site-name suffix from a page title. Matches the final
// " - Foo" / " | Foo" / " \u2013 Foo" / " \u2014 Foo" segment when the
// suffix is short enough to plausibly be a site name (\u2264 40 chars).
const TRAILING_SUFFIX_RE = /\s*[-|\u2013\u2014]\s*[^-|\u2013\u2014]{1,40}$/;

export const stripTitleSuffix = (title: string): string => title.replace(TRAILING_SUFFIX_RE, '');
