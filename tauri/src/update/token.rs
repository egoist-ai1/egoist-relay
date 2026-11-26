//! Токен чтения релизов (fine-grained PAT, только чтение одного репозитория), вшитый при сборке
//! (`build.rs`, файл вне Git). Нигде не печатается: `Debug` скрывает значение, `Display` не реализован.

/// Вшитый при сборке токен (может быть пустым). См. `build.rs`.
pub const EMBEDDED_TOKEN: &str = include_str!(concat!(env!("OUT_DIR"), "/update_token.txt"));

#[derive(Clone, Default, PartialEq, Eq)]
pub struct Token(String);

impl Token {
  /// Пустой или состоящий из недопустимых символов токен считается отсутствующим.
  pub fn new(raw: &str) -> Token {
    let t = raw.trim();
    let ok = !t.is_empty()
      && t.len() <= 255
      && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Token(t.to_string()) } else { Token(String::new()) }
  }

  pub fn empty() -> Token {
    Token(String::new())
  }

  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }

  /// Значение для заголовка Authorization. Не логировать.
  pub fn expose(&self) -> &str {
    &self.0
  }

  /// Вшитый при сборке токен.
  pub fn embedded() -> Token {
    Token::new(EMBEDDED_TOKEN)
  }
}

impl std::fmt::Debug for Token {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    if self.0.is_empty() { f.write_str("Token(<пусто>)") } else { f.write_str("Token(***)") }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn debug_hides_value() {
    let t = Token::new("github_pat_ABC123");
    assert_eq!(format!("{t:?}"), "Token(***)");
    assert!(!format!("{t:?}").contains("ABC"));
    assert!(!format!("{:#?}", Some(&t)).contains("ABC"));
    assert_eq!(format!("{:?}", Token::empty()), "Token(<пусто>)");
  }

  #[test]
  fn rejects_garbage() {
    assert!(Token::new("").is_empty());
    assert!(Token::new("   \n").is_empty());
    assert!(Token::new("abc def").is_empty());
    assert!(Token::new("a\"b").is_empty());
    assert!(Token::new(&"a".repeat(300)).is_empty());
    assert_eq!(Token::new(" tok_1\n").expose(), "tok_1");
  }

  #[test]
  fn embedded_default_is_safe() {
    let t = Token::embedded();
    assert!(t.is_empty() || !t.expose().is_empty());
    assert!(!format!("{t:?}").contains(EMBEDDED_TOKEN.trim()) || EMBEDDED_TOKEN.trim().is_empty());
  }
}
