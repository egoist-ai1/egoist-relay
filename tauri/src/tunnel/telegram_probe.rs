use std::io::{self, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TELEGRAM_DC: [u8; 4] = [149, 154, 167, 51];
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const REQ_PQ_MULTI: u32 = 0xbe7e8ef1;
const RES_PQ: u32 = 0x05162463;

pub(super) fn check(port: u16) -> bool {
  probe(port, PROBE_TIMEOUT).is_ok()
}

fn probe(port: u16, timeout: Duration) -> io::Result<()> {
  let deadline = Instant::now() + timeout;
  let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
  let mut stream = TcpStream::connect_timeout(&address, timeout)?;
  let mut greeting = [0u8; 2];
  write(&mut stream, &[5, 1, 0], deadline)?;
  read(&mut stream, &mut greeting, deadline)?;
  if greeting != [5, 0] { return Err(invalid_reply()); }

  let mut connect = [5, 1, 0, 1, 0, 0, 0, 0, 1, 187];
  connect[4..8].copy_from_slice(&TELEGRAM_DC);
  write(&mut stream, &connect, deadline)?;
  let mut reply = [0u8; 4];
  read(&mut stream, &mut reply, deadline)?;
  if reply[..3] != [5, 0, 0] { return Err(invalid_reply()); }
  let address_len = match reply[3] {
    1 => 4,
    4 => 16,
    3 => {
      let mut length = [0];
      read(&mut stream, &mut length, deadline)?;
      usize::from(length[0])
    }
    _ => return Err(invalid_reply()),
  };
  read(&mut stream, &mut [0; 257][..address_len + 2], deadline)?;

  // `req_pq_multi` проверяет маршрут до Telegram, не создавая сессию или авторизацию.
  let nonce = *uuid::Uuid::new_v4().as_bytes();
  let time = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| invalid_reply())?;
  let message_id = (time.as_secs() << 32) | ((u64::from(time.subsec_nanos()) << 32) / 1_000_000_000 & !3);
  let mut request = [0u8; 42];
  request[..2].copy_from_slice(&[0xef, 10]);
  request[10..18].copy_from_slice(&message_id.to_le_bytes());
  request[18..22].copy_from_slice(&20u32.to_le_bytes());
  request[22..26].copy_from_slice(&REQ_PQ_MULTI.to_le_bytes());
  request[26..].copy_from_slice(&nonce);
  write(&mut stream, &request, deadline)?;

  let mut prefix = [0];
  read(&mut stream, &mut prefix, deadline)?;
  let words = if prefix[0] == 0x7f {
    let mut extended = [0; 4];
    read(&mut stream, &mut extended[..3], deadline)?;
    u32::from_le_bytes(extended) as usize
  } else {
    usize::from(prefix[0])
  };
  if !(10..=256).contains(&words) { return Err(invalid_reply()); }
  let mut response = [0; 1024];
  read(&mut stream, &mut response[..words * 4], deadline)?;
  if response[..8] != [0; 8] || response[20..24] != RES_PQ.to_le_bytes() || response[24..40] != nonce {
    return Err(invalid_reply());
  }
  Ok(())
}

fn read(stream: &mut TcpStream, mut data: &mut [u8], deadline: Instant) -> io::Result<()> {
  while !data.is_empty() {
    stream.set_read_timeout(Some(remaining(deadline)?))?;
    let bytes = stream.read(data)?;
    if bytes == 0 { return Err(io::Error::from(ErrorKind::UnexpectedEof)); }
    data = &mut data[bytes..];
  }
  Ok(())
}

fn write(stream: &mut TcpStream, bytes: &[u8], deadline: Instant) -> io::Result<()> {
  stream.set_write_timeout(Some(remaining(deadline)?))?;
  stream.write_all(bytes)
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
  deadline.checked_duration_since(Instant::now()).filter(|delay| !delay.is_zero())
    .ok_or_else(|| io::Error::from(ErrorKind::TimedOut))
}

fn invalid_reply() -> io::Error { io::Error::from(ErrorKind::InvalidData) }

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  fn test_proxy(correct_nonce: bool) -> bool {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let proxy = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut greeting = [0; 3];
      stream.read_exact(&mut greeting).unwrap();
      assert_eq!(greeting, [5, 1, 0]);
      stream.write_all(&[5, 0]).unwrap();
      let mut connection = [0; 10];
      stream.read_exact(&mut connection).unwrap();
      assert_eq!(&connection[4..8], &TELEGRAM_DC);
      stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
      let mut request = [0; 42];
      stream.read_exact(&mut request).unwrap();
      assert_eq!(request[..2], [0xef, 10]);
      let mut response = [0; 41];
      response[0] = 10;
      response[21..25].copy_from_slice(&RES_PQ.to_le_bytes());
      response[25..].copy_from_slice(&request[26..]);
      if !correct_nonce { response[25] ^= 1; }
      stream.write_all(&response).unwrap();
    });
    let result = check(port);
    proxy.join().unwrap();
    result
  }

  #[test]
  fn requires_telegram_response_through_socks_by_ipv4() {
    assert!(test_proxy(true));
    assert!(!test_proxy(false));
  }
}
