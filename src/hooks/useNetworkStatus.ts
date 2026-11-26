import { useEffect, useState } from '../lib/teact/teact';

import { getCachedNetworkStatus, watchNetworkStatus } from '../util/tauri/relayNetwork';

// Статус сети Relay: последнее известное значение и обновления по событию оболочки
export default function useNetworkStatus() {
  const [status, setStatus] = useState(getCachedNetworkStatus);

  useEffect(() => watchNetworkStatus(setStatus), []);

  return status;
}
