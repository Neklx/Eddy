//! Minimal JSON. Objects keep insertion order so saved profiles diff cleanly.

use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

#[derive(Debug, PartialEq)]
pub struct ParseError { pub pos: usize, pub msg: &'static str }

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON error at byte {}: {}", self.pos, self.msg)
    }
}
impl std::error::Error for ParseError {}

impl Json {
    pub fn obj() -> Self { Json::Obj(Vec::new()) }
    pub fn with(mut self, k: &str, v: impl Into<Json>) -> Self {
        if let Json::Obj(items) = &mut self {
            items.push((k.to_string(), v.into()));
        }
        self
    }
    pub fn get(&self, k: &str) -> Option<&Json> {
        match self { Json::Obj(items) => items.iter().find(|(key, _)| key == k).map(|(_, v)| v), _ => None }
    }
    pub fn as_f64(&self) -> Option<f64> { if let Json::Num(n) = self { Some(*n) } else { None } }
    pub fn as_f32(&self) -> Option<f32> { self.as_f64().map(|v| v as f32) }
    pub fn as_i64(&self) -> Option<i64> { self.as_f64().map(|v| v as i64) }
    pub fn as_bool(&self) -> Option<bool> { if let Json::Bool(b) = self { Some(*b) } else { None } }
    pub fn as_str(&self) -> Option<&str> { if let Json::Str(s) = self { Some(s) } else { None } }
    pub fn as_arr(&self) -> Option<&[Json]> { if let Json::Arr(a) = self { Some(a) } else { None } }

    pub fn parse(s: &str) -> Result<Json, ParseError> {
        let mut p = Parser { b: s.as_bytes(), i: 0, depth: 0 };
        p.ws();
        let v = p.value()?;
        p.ws();
        if p.i != p.b.len() { return Err(p.err("trailing characters")); }
        Ok(v)
    }

    pub fn to_string(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 { let _ = write!(out, "{}", *n as i64); }
                else if n.is_finite() { let _ = write!(out, "{}", n); }
                else { out.push_str("null"); }
            }
            Json::Str(s) => write_str(s, out),
            Json::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() { if i > 0 { out.push(','); } v.write(out); }
                out.push(']');
            }
            Json::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    write_str(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => { let _ = write!(out, "\\u{:04x}", c as u32); }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl From<f64> for Json { fn from(v: f64) -> Self { Json::Num(v) } }
impl From<f32> for Json { fn from(v: f32) -> Self { Json::Num(v as f64) } }
impl From<i64> for Json { fn from(v: i64) -> Self { Json::Num(v as f64) } }
impl From<u32> for Json { fn from(v: u32) -> Self { Json::Num(v as f64) } }
impl From<usize> for Json { fn from(v: usize) -> Self { Json::Num(v as f64) } }
impl From<bool> for Json { fn from(v: bool) -> Self { Json::Bool(v) } }
impl From<&str> for Json { fn from(v: &str) -> Self { Json::Str(v.to_string()) } }
impl From<String> for Json { fn from(v: String) -> Self { Json::Str(v) } }
impl<T: Into<Json>> From<Vec<T>> for Json { fn from(v: Vec<T>) -> Self { Json::Arr(v.into_iter().map(Into::into).collect()) } }

struct Parser<'a> { b: &'a [u8], i: usize, depth: usize }

impl<'a> Parser<'a> {
    fn err(&self, msg: &'static str) -> ParseError { ParseError { pos: self.i, msg } }
    fn ws(&mut self) { while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') { self.i += 1; } }
    fn eat(&mut self, c: u8) -> bool { if self.b.get(self.i) == Some(&c) { self.i += 1; true } else { false } }
    fn lit(&mut self, s: &str, v: Json) -> Result<Json, ParseError> {
        if self.b[self.i..].starts_with(s.as_bytes()) { self.i += s.len(); Ok(v) } else { Err(self.err("bad literal")) }
    }

    fn value(&mut self) -> Result<Json, ParseError> {
        self.depth += 1;
        if self.depth > 64 { return Err(self.err("nesting too deep")); }
        let r = match self.b.get(self.i) {
            None => Err(self.err("unexpected end")),
            Some(b'n') => self.lit("null", Json::Null),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'"') => self.string().map(Json::Str),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.number(),
            _ => Err(self.err("unexpected character")),
        };
        self.depth -= 1;
        r
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let s = self.i;
        while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') { self.i += 1; }
        std::str::from_utf8(&self.b[s..self.i]).ok().and_then(|t| t.parse::<f64>().ok()).map(Json::Num).ok_or(self.err("bad number"))
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i).ok_or(self.err("unterminated string"))?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or(self.err("bad escape"))?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'), b'\\' => out.push('\\'), b'/' => out.push('/'),
                        b'n' => out.push('\n'), b'r' => out.push('\r'), b't' => out.push('\t'),
                        b'b' => out.push('\u{8}'), b'f' => out.push('\u{c}'),
                        b'u' => {
                            let hex = self.b.get(self.i..self.i + 4).and_then(|h| std::str::from_utf8(h).ok()).ok_or(self.err("bad \\u"))?;
                            let cp = u32::from_str_radix(hex, 16).map_err(|_| self.err("bad \\u"))?;
                            self.i += 4;
                            out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        }
                        _ => return Err(self.err("bad escape")),
                    }
                }
                _ => {
                    // copy a full UTF-8 sequence
                    let start = self.i - 1;
                    let len = match c { 0..=0x7f => 1, 0xc0..=0xdf => 2, 0xe0..=0xef => 3, _ => 4 };
                    let end = start + len;
                    let chunk = self.b.get(start..end).and_then(|x| std::str::from_utf8(x).ok()).ok_or(self.err("bad utf-8"))?;
                    out.push_str(chunk);
                    self.i = end;
                }
            }
        }
    }

    fn array(&mut self) -> Result<Json, ParseError> {
        self.i += 1;
        let mut v = Vec::new();
        self.ws();
        if self.eat(b']') { return Ok(Json::Arr(v)); }
        loop {
            self.ws();
            v.push(self.value()?);
            self.ws();
            if self.eat(b',') { continue; }
            if self.eat(b']') { return Ok(Json::Arr(v)); }
            return Err(self.err("expected , or ]"));
        }
    }

    fn object(&mut self) -> Result<Json, ParseError> {
        self.i += 1;
        let mut v = Vec::new();
        self.ws();
        if self.eat(b'}') { return Ok(Json::Obj(v)); }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') { return Err(self.err("expected key")); }
            let k = self.string()?;
            self.ws();
            if !self.eat(b':') { return Err(self.err("expected :")); }
            self.ws();
            v.push((k, self.value()?));
            self.ws();
            if self.eat(b',') { continue; }
            if self.eat(b'}') { return Ok(Json::Obj(v)); }
            return Err(self.err("expected , or }"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_nested() {
        let v = Json::obj().with("name", "Streaming").with("gain", 0.5f32).with("on", true)
            .with("routes", vec![1i64, 2, 3]).with("quote", "a \"b\"\n\u{e9}");
        let s = v.to_string();
        assert_eq!(Json::parse(&s).unwrap(), v);
    }

    #[test]
    fn parses_whitespace_and_numbers() {
        let v = Json::parse(" { \"a\" : [ 1 , -2.5e1 , null ] } ").unwrap();
        assert_eq!(v.get("a").unwrap().as_arr().unwrap()[1].as_f64(), Some(-25.0));
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        for bad in ["", "{", "[1,", "{\"a\":}", "tru", "\"abc", "1 2", "{\"a\" 1}", "[\"\\x\"]"] {
            assert!(Json::parse(bad).is_err(), "{bad}");
        }
        assert!(Json::parse(&"[".repeat(100)).is_err());
    }
}
