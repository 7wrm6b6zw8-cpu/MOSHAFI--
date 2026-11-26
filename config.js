// عنوان الـ API: يمكن تغييره إلى الـ Worker بتعيين localStorage.moshafi_api_base
export const API_BASE = (() => {
  try { return localStorage.getItem('moshafi_api_base') || 'https://api.quran.com/api/v4'; }
  catch { return 'https://api.quran.com/api/v4'; }
})();
