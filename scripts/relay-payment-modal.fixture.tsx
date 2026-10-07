/** @jsxImportSource @teact */
import './relay-ui-audit.fixture';
import { getActions, getGlobal, setGlobal } from '../src/global';
import { selectTabState } from '../src/global/selectors';
import { getCurrentTabId } from '../src/util/establishMultitabRole';
import { PaymentStep } from '../src/types';
import type { ApiPaymentFormRegular, ApiPaymentFormStars, ApiUser } from '../src/api/types';
import type { GlobalState, TabState } from '../src/global/types';

// Bodies render through actual App/Main/ModalContainer. No replica payment JSX or account transport.
const events: { name: string; detail?: unknown }[] = [];
const record = (name: string, detail?: unknown) => { events.push({ name, detail }); };
const invoice = { prices: [{ label: 'Synthetic item', amount: 25 }], totalAmount: 25, currency: 'XTR', isTest: true };
const regularForm: ApiPaymentFormRegular = {
  type: 'regular', url: 'https://example.test/synthetic-payment', botId: '9000100', formId: 'synthetic-regular',
  providerId: 'synthetic-provider', nativeProvider: 'stripe', nativeParams: {},
  invoice: { ...invoice, currency: 'USD' }, title: 'Synthetic regular invoice', description: 'Local callback fixture only',
};
const starsForm: ApiPaymentFormStars = {
  type: 'stars', formId: 'synthetic-stars', botId: '9000100', title: 'Synthetic Stars item', description: 'Local callback only', invoice,
};
const syntheticBot: ApiUser = { id: '9000100', type: 'userTypeBot', isMin: false, firstName: 'Synthetic payment bot', phoneNumber: '' };
const stars: NonNullable<GlobalState['stars']> = {
  topupOptions: [], balance: { currency: 'XTR', amount: 1000, nanos: 0 },
  history: { all: undefined, inbound: undefined, outbound: undefined },
};
function patch(payment: TabState['payment'], starsPayment: TabState['starsPayment']) {
  const global = getGlobal(); const tab = selectTabState(global); const tabId = getCurrentTabId();
  setGlobal({ ...global, users: { ...global.users, byId: { ...global.users.byId, [syntheticBot.id]: syntheticBot } },
    stars, byTabId: { ...global.byTabId, [tabId]: { ...tab, payment, starsPayment } } });
}
function close() { patch({ isPaymentModalOpen: false }, {}); }
function install() {
  const actions = getActions();
  actions.loadPasswordInfo = () => record('loadPasswordInfo');
  actions.validatePaymentPassword = ({ password }) => record('validatePassword', { length: password.length });
  actions.sendPaymentForm = () => record('regularPay');
  actions.sendCredentialsInfo = () => record('credentials');
  actions.sendStarPaymentForm = () => record('starsPay');
  actions.openStarsBalanceModal = () => record('topup');
  actions.clearPaymentError = () => record('clearPaymentError');
  actions.closePaymentModal = () => { record('closeRegular'); close(); };
  actions.closeStarsPaymentModal = () => { record('closeStars'); close(); };
}
(window as any).__relayPaymentAudit = {
  events, close,
  open(kind: 'regular' | 'stars') {
    install();
    close();
    if (kind === 'regular') patch({
      isPaymentModalOpen: true, step: PaymentStep.ConfirmPassword, form: regularForm,
      inputInvoice: { type: 'slug', slug: 'synthetic-regular' },
    }, {});
    else patch({ isPaymentModalOpen: false }, {
      form: starsForm, inputInvoice: { type: 'slug', slug: 'synthetic-stars' },
    });
  },
  state() { const tab = selectTabState(getGlobal()); return { paymentOpen: tab.payment.isPaymentModalOpen, paymentStep: tab.payment.step, starsOpen: Boolean(tab.starsPayment.inputInvoice) }; },
};

