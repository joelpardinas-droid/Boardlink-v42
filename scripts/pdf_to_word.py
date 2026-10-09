#!/usr/bin/env python3
# ============================================================
# scripts/pdf_to_word.py — turn an agenda item's PDF into Word
# ============================================================
#
# Used by services/wordEditService.js so the Board Secretary can
# correct the wording of an agenda document in Microsoft Word and
# send it back to BOARDLINK.
#
# pdf2docx is used rather than LibreOffice's own PDF import: that
# import puts every line of the page in its own fixed-size box, so a
# word made longer is silently cut off. pdf2docx produces ordinary
# Word paragraphs that re-flow as they are edited.
#
#   python3 pdf_to_word.py <in.pdf> <out.docx>
#
# Exit codes
#   0  the Word file was written
#   3  pdf2docx is not installed on this server
#   4  the PDF holds no text to edit (a scan)
#   5  the PDF could not be converted
#
# Anything printed on stderr is shown to the Secretary, so messages
# are written in plain words.

import sys
import os


def fail(code, message):
    # On Windows the screen uses an old character set (cp1252) that has
    # no "≤", "₱" or curly quotes. A message carrying one — a file name,
    # or text quoted out of the document — would otherwise raise a
    # UnicodeEncodeError on top of the problem being reported.
    text = message.strip() + "\n"
    try:
        sys.stderr.write(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stderr, 'encoding', None) or 'ascii'
        sys.stderr.write(text.encode(enc, 'replace').decode(enc, 'replace'))
    sys.exit(code)


def main():
    if len(sys.argv) != 3:
        fail(5, "Usage: pdf_to_word.py <in.pdf> <out.docx>")
    src, dest = sys.argv[1], sys.argv[2]
    if not os.path.isfile(src):
        fail(5, "The PDF to convert was not found.")

    try:
        from pdf2docx import Converter
    except Exception:
        fail(3, "Word editing is not set up on this server: the pdf2docx "
                "converter is not installed.")

    # A scan has no text to edit. Checked here so the Secretary is told
    # plainly instead of receiving a Word file holding only a picture.
    try:
        import fitz  # PyMuPDF, installed with pdf2docx
        with fitz.open(src) as doc:
            chars = sum(len(page.get_text().strip()) for page in doc)
        if chars < 20:
            fail(4, "This PDF is a scan — a picture of paper — so its words "
                    "cannot be edited in Word.")
    except SystemExit:
        raise
    except Exception:
        pass  # if the check itself fails, let the conversion decide

    try:
        conv = Converter(src)
        try:
            conv.convert(dest)
        finally:
            conv.close()
    except Exception as err:
        fail(5, "This PDF could not be turned into a Word file (%s)."
                % str(err)[:200])

    if not os.path.isfile(dest) or os.path.getsize(dest) < 1000:
        fail(5, "This PDF could not be turned into a Word file.")


if __name__ == "__main__":
    main()
