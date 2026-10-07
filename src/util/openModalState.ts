import { requestMutation } from '../lib/fasterdom/fasterdom';

let openModalCount = 0;

export default function acquireOpenModal() {
  let isReleased = false;
  openModalCount += 1;
  updateBodyDialogClass();

  return () => {
    if (isReleased) return;
    isReleased = true;
    openModalCount -= 1;
    updateBodyDialogClass();
  };
}

function updateBodyDialogClass() {
  requestMutation(() => {
    document.body.classList.toggle('has-open-dialog', openModalCount > 0);
  });
}
