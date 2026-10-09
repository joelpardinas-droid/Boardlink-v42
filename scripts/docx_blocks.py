#!/usr/bin/env python3
# ============================================================
# scripts/docx_blocks.py — the words of a Word file, as blocks
# ============================================================
#
# Lets the Board Secretary correct the wording of an agenda document
# inside BOARDLINK instead of downloading it. Used by
# services/wordEditService.js.
#
#   read  <in.docx> <blocks.json>          → JSON blocks written to that file
#   write <in.docx> <edits.json> <out.docx>
#
# The blocks go to a FILE, not to the screen. On Windows, Python writes
# to the screen in an old character set (cp1252) that has no "≤", "₱",
# "—" or curly quotes, so a board paper containing any of them would
# stop the whole thing with a UnicodeEncodeError. A file is written as
# UTF-8 whatever the computer's screen uses.
#
# A "block" is one paragraph of the document — including paragraphs
# inside table cells — with a stable id, so the browser can send back
# just the ones that changed.
#
# Two things inside a paragraph must survive a round trip, or lines of
# the document disappear:
#
#   • a line break (<w:br/>) — pdf2docx often puts several visual
#     lines in ONE paragraph, separated by breaks. They are read as
#     "\n" and written back as breaks.
#   • a tab (<w:tab/>) — read and written as "\t".
#
# Formatting: only the letters that actually changed are touched. The
# rest of an edited paragraph keeps its own look (a bold term stays bold,
# the rest stays plain), and its page breaks, pictures and links stay.
# New words take the look of the letter just before them, as in Word.
# Untouched paragraphs are not rewritten at all.
#
# Exit codes
#   0  fine
#   2  the edits could not be read or referred to blocks that are gone
#   5  the Word file could not be opened

import copy
import json
import sys

try:
    import docx
    from docx.oxml.ns import qn
except Exception:
    sys.stderr.write("python-docx is not installed on this server.\n")
    sys.exit(5)


def fail(code, message):
    # The message may carry a file name or a document's words, so it can
    # hold characters the screen's character set does not have. Anything
    # unprintable is replaced rather than raising a second error on top
    # of the one being reported.
    text = message.strip() + "\n"
    try:
        sys.stderr.write(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stderr, 'encoding', None) or 'ascii'
        sys.stderr.write(text.encode(enc, 'replace').decode(enc, 'replace'))
    sys.exit(code)


# ── reading ──────────────────────────────────────────────────

def visible_runs(p):
    """
    Every run whose words show in the paragraph, in order: plain runs and
    runs inside links, inserted (tracked) text and the like. Text that
    was deleted with Track Changes (w:delText) is not shown.
    """
    return [r for r in p._p.iter(qn('w:r'))]


def char_map(p):
    """
    The paragraph as a list of characters, each remembering the element
    it comes from, so an edit can change exactly the letters that changed:
      ('t', <w:t>, i)  the i-th letter of a text element
      ('x', <node>, 0) a break ("\n") or a tab ("\t")
    """
    chars = []
    for run in visible_runs(p):
        for node in run:
            tag = node.tag
            if tag == qn('w:t'):
                for i, ch in enumerate(node.text or ''):
                    chars.append((ch, 't', node, i))
            elif tag == qn('w:br') or tag == qn('w:cr'):
                chars.append(('\n', 'x', node, 0))
            elif tag == qn('w:tab'):
                chars.append(('\t', 'x', node, 0))
    return chars


def para_text(p):
    """The paragraph's words, with "\n" for a break and "\t" for a tab."""
    return ''.join(c[0] for c in char_map(p))


def content_element(container):
    """
    The element whose children are the paragraphs and tables. For the
    document that is <w:body>, not <w:document>; for a table cell it is
    the cell itself.
    """
    el = container._element
    body = el.find(qn('w:body'))
    return body if body is not None else el


def walk(container, prefix, blocks):
    """Paragraphs and tables in the order they appear in the document."""
    body = content_element(container)
    p_at = t_at = 0
    for child in body.iterchildren():
        if child.tag == qn('w:p'):
            for p in container.paragraphs:
                if p._element is child:
                    blocks.append({
                        'id': f'{prefix}p{p_at}',
                        'kind': 'paragraph',
                        'text': para_text(p),
                        'style': p.style.name if p.style is not None else 'Normal',
                    })
                    break
            p_at += 1
        elif child.tag == qn('w:tbl'):
            for t in container.tables:
                if t._element is child:
                    for ri, row in enumerate(t.rows):
                        for ci, cell in enumerate(row.cells):
                            walk(cell, f'{prefix}t{t_at}r{ri}c{ci}.', blocks)
                    break
            t_at += 1


def find_paragraph(doc, block_id):
    """The paragraph a block id points at, or None."""
    parts = block_id.split('.')
    container = doc
    for part in parts[:-1]:
        # t<table>r<row>c<col>
        try:
            t_part, rest = part.split('r', 1)
            row_s, col_s = rest.split('c', 1)
            t_i, row_i, col_i = int(t_part[1:]), int(row_s), int(col_s)
        except Exception:
            return None
        tables = [c for c in content_element(container).iterchildren() if c.tag == qn("w:tbl")]
        if t_i >= len(tables):
            return None
        table = next((t for t in container.tables if t._element is tables[t_i]), None)
        if table is None or row_i >= len(table.rows):
            return None
        row = table.rows[row_i]
        if col_i >= len(row.cells):
            return None
        container = row.cells[col_i]
    last = parts[-1]
    if not last.startswith('p'):
        return None
    try:
        idx = int(last[1:])
    except ValueError:
        return None
    paragraphs = container.paragraphs
    return paragraphs[idx] if idx < len(paragraphs) else None


# ── writing ──────────────────────────────────────────────────

def _new_nodes(run_el, text):
    """Elements for `text`: w:t pieces, with w:br for "\n" and w:tab for "\t"."""
    nodes = []
    for i, line in enumerate(text.split('\n')):
        if i:
            nodes.append(run_el.makeelement(qn('w:br'), {}))
        for j, piece in enumerate(line.split('\t')):
            if j:
                nodes.append(run_el.makeelement(qn('w:tab'), {}))
            if piece:
                t = run_el.makeelement(qn('w:t'), {})
                t.text = piece
                t.set(qn('xml:space'), 'preserve')
                nodes.append(t)
    return nodes


def set_para_text(p, text):
    """
    Changes the paragraph's words to `text` by touching ONLY the letters
    that differ. The unchanged beginning and end of the paragraph are left
    exactly as they were, so their formatting (a bold term, italics), page
    breaks, pictures, links and fields all survive. New words take the
    look of the letter just before them, as typing in Word does.
    """
    text = str(text)
    chars = char_map(p)
    old = ''.join(c[0] for c in chars)
    if old == text:
        return

    if not chars:
        # An empty paragraph: give it one run.
        run = p.add_run('')
        for n in _new_nodes(run._element, text):
            run._element.append(n)
        return

    # The part that changed: after the common beginning, before the common end.
    pre = 0
    while pre < len(old) and pre < len(text) and old[pre] == text[pre]:
        pre += 1
    suf = 0
    while (suf < len(old) - pre and suf < len(text) - pre
           and old[len(old) - 1 - suf] == text[len(text) - 1 - suf]):
        suf += 1
    gone = chars[pre:len(old) - suf]            # letters and breaks removed
    added = text[pre:len(text) - suf]           # what is typed in their place

    # Where the new words go: right after the last unchanged letter before
    # the change (so they look like it), or before the first letter.
    if pre > 0:
        _, kind, node, i = chars[pre - 1]
        after = True
    else:
        _, kind, node, i = chars[0]
        after = False

    # 1) Remove what was deleted. Letters are cut out of their w:t
    #    elements; a removed break or tab loses its element.
    cut = {}
    for _, k, n, idx in gone:
        if k == 't':
            cut.setdefault(n, set()).add(idx)
        else:
            if n is node:
                # The anchor itself is removed; anchor on its run instead.
                pass
            n.getparent().remove(n) if n.getparent() is not None else None
    for n, idxs in cut.items():
        n.text = ''.join(ch for j, ch in enumerate(n.text or '') if j not in idxs)
        n.set(qn('xml:space'), 'preserve')

    if not added:
        return

    # 2) Insert the new words at the anchor.
    if kind == 't':
        # Split the text element at the insertion point (its letters
        # before that point were not cut, so the index still holds).
        split_at = i + 1 if after else i
        before = sum(1 for j in range(split_at) if j not in cut.get(node, ()))
        full = node.text or ''
        head, tail = full[:before], full[before:]
        run_el = node.getparent()
        node.text = head
        node.set(qn('xml:space'), 'preserve')
        pos = list(run_el).index(node) + 1
        new = _new_nodes(run_el, added)
        if tail:
            t = run_el.makeelement(qn('w:t'), {})
            t.text = tail
            t.set(qn('xml:space'), 'preserve')
            new.append(t)
        for k, n in enumerate(new):
            run_el.insert(pos + k, n)
    else:
        # The anchor is a break or tab: put the words next to it.
        run_el = node.getparent()
        if run_el is None:
            run_el = visible_runs(p)[0]
            pos = len(run_el)
        else:
            pos = list(run_el).index(node) + (1 if after else 0)
        for k, n in enumerate(_new_nodes(run_el, added)):
            run_el.insert(pos + k, n)


# ── entry point ──────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        fail(5, 'Usage: docx_blocks.py read <in.docx> | write <in.docx> <edits.json> <out.docx>')
    mode, src = sys.argv[1], sys.argv[2]

    try:
        doc = docx.Document(src)
    except Exception as err:
        fail(5, 'This Word file could not be opened (%s).' % str(err)[:160])

    if mode == 'read':
        if len(sys.argv) != 4:
            fail(5, 'Usage: docx_blocks.py read <in.docx> <blocks.json>')
        blocks = []
        walk(doc, '', blocks)
        try:
            with open(sys.argv[3], 'w', encoding='utf-8') as fh:
                json.dump({'blocks': blocks}, fh, ensure_ascii=False)
        except Exception as err:
            fail(5, 'The words of this document could not be written out (%s).' % str(err)[:160])
        return

    if mode == 'write':
        if len(sys.argv) != 5:
            fail(5, 'Usage: docx_blocks.py write <in.docx> <edits.json> <out.docx>')
        edits_path, dest = sys.argv[3], sys.argv[4]
        try:
            with open(edits_path, encoding='utf-8') as fh:
                edits = json.load(fh)
        except Exception as err:
            fail(2, 'The changes could not be read (%s).' % str(err)[:160])
        if not isinstance(edits, list):
            fail(2, 'The changes could not be read.')

        applied = 0
        for edit in edits:
            if not isinstance(edit, dict):
                fail(2, 'The changes could not be read.')
            block_id = str(edit.get('id', ''))
            text = edit.get('text', '')
            if not isinstance(text, str):
                fail(2, 'The changes could not be read.')
            p = find_paragraph(doc, block_id)
            if p is None:
                fail(2, 'This document changed while it was being edited, '
                        'so the changes could not be saved. Open it again.')
            set_para_text(p, text)
            applied += 1

        try:
            doc.save(dest)
        except Exception as err:
            fail(5, 'The edited document could not be saved (%s).' % str(err)[:160])
        # Plain ASCII, so it is safe on any screen character set.
        sys.stdout.write('{"applied": %d}' % applied)
        return

    fail(5, 'Unknown mode: %s' % mode)


if __name__ == '__main__':
    main()
