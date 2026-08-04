'use strict';

(function () {
  function ensureSwal() {
    if (typeof Swal === 'undefined') {
      console.error('SweetAlert2 尚未載入');
      return false;
    }
    return true;
  }

  window.notify = {
    error(msg) {
      if (!ensureSwal()) return window.alert(msg);
      return Swal.fire({
        icon: 'error',
        title: '錯誤',
        text: String(msg || ''),
        confirmButtonText: '關閉',
        confirmButtonColor: '#13b5ea',
      });
    },
    warn(msg) {
      if (!ensureSwal()) return window.alert(msg);
      return Swal.fire({
        icon: 'warning',
        title: '注意',
        text: String(msg || ''),
        confirmButtonText: '關閉',
        confirmButtonColor: '#13b5ea',
      });
    },
    info(msg) {
      if (!ensureSwal()) return window.alert(msg);
      return Swal.fire({
        icon: 'info',
        title: '提示',
        text: String(msg || ''),
        confirmButtonText: '關閉',
        confirmButtonColor: '#13b5ea',
      });
    },
    success(msg) {
      if (!ensureSwal()) return window.alert(msg);
      return Swal.fire({
        icon: 'success',
        title: '完成',
        text: String(msg || ''),
        timer: 1500,
        showConfirmButton: false,
      });
    },
    toast(msg, icon) {
      if (!ensureSwal()) return;
      return Swal.fire({
        toast: true,
        position: 'top-end',
        icon: icon || 'info',
        title: String(msg || ''),
        showConfirmButton: false,
        timer: 2200,
        timerProgressBar: true,
      });
    },
    confirm(msg) {
      if (!ensureSwal()) return Promise.resolve(window.confirm(msg));
      return Swal.fire({
        icon: 'question',
        title: '確認',
        text: String(msg || ''),
        showCancelButton: true,
        confirmButtonText: '確定',
        cancelButtonText: '取消',
        confirmButtonColor: '#13b5ea',
      }).then((r) => !!r.isConfirmed);
    },
  };
})();
