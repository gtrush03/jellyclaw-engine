/**
 * Pure diagnostic helper for the Edit tool's NoMatch path.
 *
 * Given the file contents and the `old_string` the model tried to replace,
 * return a short one-line hint describing why the match failed. Must never
 * leak more than ~200 chars of file content back to the model.
 */

const LINE_NUMBER_PREFIX = /^\d+\t/;

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function explainMissingMatch(content: string, oldString: string): string {
  if (oldString.length === 0) {
    return "old_string is empty.";
  }

  if (LINE_NUMBER_PREFIX.test(oldString)) {
    return 'old_string appears to start with a line-number prefix (e.g. "42\\t..."). The Read tool\'s "<lineNo>\\t<content>" format must be stripped before passing to Edit.';
  }

  const fileHasCrlf = content.includes("\r\n");
  const oldHasCrlf = oldString.includes("\r\n");

  if (fileHasCrlf && !oldHasCrlf && content.replace(/\r\n/g, "\n").includes(oldString)) {
    return "File uses CRLF line endings but old_string uses LF. Convert line endings to match.";
  }

  if (!fileHasCrlf && oldHasCrlf) {
    return "old_string uses CRLF but file uses LF. Strip \\r from old_string.";
  }

  const normContent = normalizeWhitespace(content);
  const normOld = normalizeWhitespace(oldString);
  if (normOld.length > 0 && normContent.includes(normOld)) {
    return "old_string matches the file content only after whitespace normalization. Check indentation / tabs vs spaces / trailing whitespace.";
  }

  return "old_string was not found in the file. Check that the text exists verbatim (case-sensitive, including exact whitespace and line endings).";
}
