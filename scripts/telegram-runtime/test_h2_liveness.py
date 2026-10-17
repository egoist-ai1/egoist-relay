"""Тест логики h2-liveness.patch: бан lane (failed_until), таймаут первого байта, H2 PING.

Без сети. Запуск из корня репозитория, путь к клону с применёнными патчами - аргумент:

    python -I scripts/telegram-runtime/test_h2_liveness.py <путь-к-клону-tg-ws-proxy>

Нужны пакеты из requirements-build.txt (httpx, h2, cryptography): запускайте
python из виртуального окружения сборки.
"""
import asyncio
import sys
import time
import unittest
from unittest import mock

if len(sys.argv) < 2:
    sys.exit(__doc__)
sys.path.insert(0, sys.argv.pop(1))

import httpx  # noqa: E402
from h2.connection import H2Connection  # noqa: E402
from h2.config import H2Configuration  # noqa: E402

from proxy import cf_h2, h2_transport  # noqa: E402
from proxy.balancer import balancer  # noqa: E402


class BanDelayTest(unittest.TestCase):
    def test_exponential_from_5_to_60(self):
        self.assertEqual([cf_h2.ban_delay(n) for n in range(7)], [5, 10, 20, 40, 60, 60, 60])

    def test_lane_escalates_resets_and_does_not_stack(self):
        async def scenario():
            lane = cf_h2._HttpLane('kws2.a.test', 1)
            try:
                lane.mark_failed(100.0)
                self.assertEqual(lane.failed_until, 105.0)
                lane.mark_failed(101.0)  # уже в бане: срок и счётчик не растут
                self.assertEqual((lane.failed_until, lane.failure_strikes), (105.0, 1))
                lane.mark_failed(106.0)
                self.assertEqual(lane.failed_until, 116.0)
                lane.mark_failed(117.0)
                self.assertEqual(lane.failed_until, 137.0)
                lane.mark_ok()
                self.assertEqual((lane.failed_until, lane.failure_strikes), (0.0, 0))
                lane.mark_failed(200.0)
                self.assertEqual(lane.failed_until, 205.0)
            finally:
                await lane.close()
        asyncio.run(scenario())

    def test_pool_host_ban_uses_same_schedule(self):
        pool = cf_h2.CfH2Pool()
        pool._mark_host_failed('h', 10.0)
        pool._mark_host_failed('h', 16.0)
        self.assertEqual(pool.failed_until['h'], 26.0)


class PoolSelectionTest(unittest.TestCase):
    def setUp(self):
        balancer.update_domains_list(['a.test', 'b.test'])

    def run_pool(self, scenario):
        async def main():
            pool = cf_h2.CfH2Pool()
            try:
                await scenario(pool)
            finally:
                await pool.close()
        asyncio.run(main())

    def test_all_banned_soon_picks_smallest_failed_until(self):
        async def scenario(pool):
            now = time.monotonic()
            for index, (domain, offset) in enumerate((('a.test', 4), ('b.test', 2)), 1):
                lane = cf_h2._HttpLane('kws2.%s' % domain, index)
                lane.failed_until = now + offset
                pool.lanes[lane.host] = lane
            channel = await pool._open(2, 'test')
            self.assertIsNotNone(channel)
            self.assertEqual(channel.lane.host, 'kws2.b.test')
        self.run_pool(scenario)

    def test_all_banned_for_long_returns_none_so_ws_fallback_runs(self):
        async def scenario(pool):
            now = time.monotonic()
            for index, (domain, offset) in enumerate((('a.test', 50), ('b.test', 20)), 1):
                lane = cf_h2._HttpLane('kws2.%s' % domain, index)
                lane.failed_until = now + offset
                pool.lanes[lane.host] = lane
            self.assertIsNone(await pool._open(2, 'test'))
        self.run_pool(scenario)

    def test_banned_lane_is_skipped_while_another_is_free(self):
        async def scenario(pool):
            now = time.monotonic()
            banned = cf_h2._HttpLane('kws2.a.test', 1)
            banned.failed_until = now + 50
            free = cf_h2._HttpLane('kws2.b.test', 2)
            pool.lanes.update({banned.host: banned, free.host: free})
            channel = await pool._open(2, 'test')
            self.assertEqual(channel.lane.host, 'kws2.b.test')
        self.run_pool(scenario)

    def test_all_banned_without_lanes_does_not_probe_around_the_ban(self):
        async def scenario(pool):
            now = time.monotonic()
            pool.failed_until.update({'kws2.a.test': now + 40, 'kws2.b.test': now + 10})
            probed = []

            async def fake_select(dc, label, domains):
                probed.append(list(domains))
                return None
            pool._select_lane = fake_select
            self.assertIsNone(await pool._open(2, 'test'))
            self.assertEqual(probed, [[]])  # только обычный вызов без кандидатов
        self.run_pool(scenario)


class FakeStreamConnection:
    def __init__(self, last_stream_rx, last_rx=None):
        self.last_stream_rx = last_stream_rx
        self.last_rx = last_stream_rx if last_rx is None else last_rx
        self.streams = {}
        self.failed = None

    def fail(self, error):
        self.failed = error


class FirstByteTimeoutTest(unittest.TestCase):
    def wait(self, last_rx_offset, ping_ack_offset=None):
        async def scenario():
            now = time.monotonic()
            connection = FakeStreamConnection(
                now + last_rx_offset,
                None if ping_ack_offset is None else now + ping_ack_offset)
            stream = h2_transport._ResponseStream(connection, 1, 65.0)
            stream.sent_at = time.monotonic()
            started = time.monotonic()
            with self.assertRaises(h2_transport.FirstByteTimeout) as caught:
                await stream.wait(time.monotonic() + 0.05)
            self.assertLess(time.monotonic() - started, 1.0)  # а не 65 секунд
            return connection, caught.exception
        return asyncio.run(scenario())

    def test_silent_connection_is_failed(self):
        connection, error = self.wait(-1.0)  # после отправки не пришло ничего
        self.assertTrue(error.silent)
        self.assertIs(connection.failed, error)

    def test_alive_connection_is_kept(self):
        connection, error = self.wait(+1.0)  # пришли байты (например, ack на PING)
        self.assertFalse(error.silent)
        self.assertIsNone(connection.failed)

    def test_ping_ack_alone_does_not_make_connection_alive(self):
        # ack на PING пришёл после отправки, но ни заголовков, ни данных по стримам нет
        connection, error = self.wait(-1.0, ping_ack_offset=+1.0)
        self.assertTrue(error.silent)
        self.assertIs(connection.failed, error)

    def test_timeout_is_an_http_error_for_lane_ban(self):
        self.assertTrue(issubclass(h2_transport.FirstByteTimeout, httpx.HTTPError))


class FakeStreamContext:
    def __init__(self, error):
        self.error = error

    async def __aenter__(self):
        raise self.error

    async def __aexit__(self, *exc):
        return False


class FakeClient:
    def __init__(self, error):
        self.error = error

    def stream(self, *args, **kwargs):
        return FakeStreamContext(self.error)


class LaneBanOnTimeoutTest(unittest.TestCase):
    def post(self, replay, silent):
        async def scenario():
            lane = cf_h2._HttpLane('kws2.a.test', 1)
            error = h2_transport.FirstByteTimeout('no byte')
            error.silent = silent
            real_client, lane.client = lane.client, FakeClient(error)
            try:
                with self.assertRaises(h2_transport.FirstByteTimeout):
                    await lane._post(b'\x00' * 24, 1, replay=replay)
                return lane.failed_until
            finally:
                lane.client = real_client
                await lane.close()
        return asyncio.run(scenario())

    def test_quiet_replay_does_not_ban_lane(self):
        self.assertEqual(self.post(replay=True, silent=False), 0.0)

    def test_silent_replay_bans_lane(self):
        self.assertGreater(self.post(replay=True, silent=True), 0.0)

    def test_original_request_timeout_bans_lane(self):
        self.assertGreater(self.post(replay=False, silent=False), 0.0)


class FakeWriter:
    def __init__(self, on_write):
        self.on_write, self.closed = on_write, False

    def write(self, data):
        self.on_write(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    def get_extra_info(self, name):
        return None

    async def wait_closed(self):
        pass


class PingTest(unittest.TestCase):
    def connect(self, answer):
        """Соединение с поддельным сервером: answer=False - сервер замолкает после SETTINGS."""
        reader = asyncio.StreamReader()
        server = H2Connection(config=H2Configuration(client_side=False))
        server.initiate_connection()
        reader.feed_data(server.data_to_send())

        def on_write(data):
            if answer:
                server.receive_data(data)  # сервер сам отвечает ack на PING
                out = server.data_to_send()
                if out:
                    reader.feed_data(out)
        writer = FakeWriter(on_write)
        return h2_transport._Connection(reader, writer, 8, 5.0), writer

    def run_ping(self, answer):
        async def scenario():
            with mock.patch.object(h2_transport, 'H2_PING_INTERVAL', 0.05), \
                    mock.patch.object(h2_transport, 'H2_PING_ACK_TIMEOUT', 0.1):
                connection, writer = self.connect(answer)
                try:
                    await asyncio.sleep(0.6)
                    return connection.error, writer.closed
                finally:
                    await connection.aclose()
        return asyncio.run(scenario())

    def test_dead_connection_is_closed_when_ping_is_not_acked(self):
        error, closed = self.run_ping(False)
        self.assertIsInstance(error, httpx.ReadTimeout)
        self.assertTrue(closed)

    def test_answered_ping_keeps_connection(self):
        error, closed = self.run_ping(True)
        self.assertIsNone(error)
        self.assertFalse(closed)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
