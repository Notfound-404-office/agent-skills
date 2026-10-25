#!/usr/bin/env python3
"""Minimal JS-object-literal -> Python converter for minified bundles.

The reconstruction workflow often needs one data literal out of a minified
bundle: the app config, an ABI array, a circuit constant.  Loading the whole
bundle would execute DOM and network code, so this module parses only the
literal at a given offset.

Supported syntax is the subset rolldown/esbuild emit for plain data:
``{k: v}``, ``[..]``, backtick strings without ``${}``, ``".."``, ``'..'``,
numbers, ``!0`` / ``!1``, ``null``, ``void 0``, ``-n`` and BigInt ``123n``.
Anything else (identifiers, calls) raises ``Unsupported``, so a successful
parse is guaranteed to be pure data.
"""
import json
import re
import sys


class Unsupported(ValueError):
    """Raised when the literal contains syntax this converter does not handle."""

def match_end(src, i):
    """Index just past the bracket expression starting at src[i] ('{' or '[')."""
    depth = 0
    quote = None
    j = i
    while j < len(src):
        c = src[j]
        if quote:
            # Inside a string: skip escapes, leave on the matching quote.
            if c == '\\':
                j += 2
                continue
            if c == quote:
                quote = None
        elif c in '`"\'':
            quote = c
        elif c in '{[(':
            depth += 1
        elif c in '}])':
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    raise ValueError('unbalanced')


def enclosing(src, pos, opener='{'):
    """Start index of the innermost `opener` bracket that encloses pos."""
    closer = {'{': '}', '[': ']'}[opener]
    depth = 0
    j = pos
    while j >= 0:
        c = src[j]
        if c == closer:
            depth += 1
        elif c == opener:
            if depth == 0:
                return j
            depth -= 1
        j -= 1
    raise ValueError('no enclosing ' + opener)


# Bare identifiers are used as unquoted object keys; numbers cover decimal,
# hexadecimal, exponent and BigInt forms.
_ident = re.compile(r'[A-Za-z_$][\w$]*')
_num = re.compile(r'-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)n?')


class P:
    """Recursive-descent parser for one JavaScript literal."""

    def __init__(self, src):
        self.s = src
        self.i = 0

    def ws(self):
        """Skip JavaScript whitespace."""
        while self.i < len(self.s) and self.s[self.i] in ' \t\r\n':
            self.i += 1

    def peek(self):
        """Return the next non-whitespace character without consuming it."""
        self.ws()
        return self.s[self.i]

    def eat(self, token):
        """Consume ``token`` or fail with a location hint."""
        self.ws()
        if not self.s.startswith(token, self.i):
            raise Unsupported(
                f'expected {token!r} at {self.i}: {self.s[self.i:self.i+40]!r}'
            )
        self.i += len(token)

    def string(self):
        """Parse a quoted string or a backtick string without interpolation."""
        quote = self.s[self.i]
        self.i += 1
        out = []
        while True:
            c = self.s[self.i]
            if c == '\\':
                nxt = self.s[self.i + 1]
                if nxt == 'u':
                    out.append(chr(int(self.s[self.i + 2:self.i + 6], 16)))
                    self.i += 6
                    continue
                out.append({'n': '\n', 't': '\t', 'r': '\r', '0': '\0'}.get(nxt, nxt))
                self.i += 2
                continue
            if quote == '`' and self.s.startswith('${', self.i):
                raise Unsupported('template interpolation')
            if c == quote:
                self.i += 1
                return ''.join(out)
            out.append(c)
            self.i += 1

    def value(self):
        """Parse one value: object, array, string, keyword, or number."""
        c = self.peek()
        if c == '{':
            return self.obj()
        if c == '[':
            return self.arr()
        if c in '`"\'':
            return self.string()

        # Minified boolean/null spellings emitted by esbuild/rolldown.
        for literal, result in (
            ('!0', True),
            ('!1', False),
            ('null', None),
            ('void 0', None),
            ('true', True),
            ('false', False),
        ):
            if self.s.startswith(literal, self.i) and not (
                self.s[self.i + len(literal):self.i + len(literal) + 1].isalnum()
            ):
                self.i += len(literal)
                return result

        match = _num.match(self.s, self.i)
        if match:
            self.i = match.end()
            text = match.group().rstrip('n')
            is_integer = re.fullmatch(r'-?(0x[0-9a-fA-F]+|\d+)', text)
            return int(text, 0) if is_integer else float(text)

        raise Unsupported(f'non-literal at {self.i}: {self.s[self.i:self.i+40]!r}')

    def key(self):
        """Parse an object key: quoted string, identifier, or digits."""
        c = self.peek()
        if c in '`"\'':
            return self.string()
        match = _ident.match(self.s, self.i) or re.compile(r'\d+').match(self.s, self.i)
        if not match:
            raise Unsupported(f'bad key at {self.i}: {self.s[self.i:self.i+40]!r}')
        self.i = match.end()
        return match.group()

    def obj(self):
        """Parse ``{ ... }`` and return a dict."""
        self.eat('{')
        out = {}
        while self.peek() != '}':
            key = self.key()
            self.eat(':')
            out[key] = self.value()
            if self.peek() == ',':
                self.i += 1
        self.i += 1  # consume '}'
        return out

    def arr(self):
        """Parse ``[ ... ]`` and return a list."""
        self.eat('[')
        out = []
        while self.peek() != ']':
            out.append(self.value())
            if self.peek() == ',':
                self.i += 1
        self.i += 1  # consume ']'
        return out


def parse(src, start):
    """Parse the literal beginning at src[start]."""
    return P(src[start:match_end(src, start)]).value()


if __name__ == '__main__':
    path, start = sys.argv[1], int(sys.argv[2])
    with open(path) as fh:
        print(json.dumps(parse(fh.read(), start), indent=1))
