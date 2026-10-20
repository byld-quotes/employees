/* BYLD Labour app settings (free Firebase Spark plan).
   Firebase project: hr-admin-eb404.
   This is the only file you need to edit. */
self.BYLD_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBwRsdRWQKg7CpJFsdMY0USwcAz1190o4c",
    authDomain: "hr-admin-eb404.firebaseapp.com",
    projectId: "hr-admin-eb404",
    storageBucket: "hr-admin-eb404.firebasestorage.app",
    messagingSenderId: "911133767519",
    appId: "1:911133767519:web:b040e18ebca043a75f68ea"
  },

  /* Email the admins on every new request and new phone (same EmailJS account as the quotation app).
     Leave serviceId empty to switch email alerts off. */
  emailjs: { publicKey: "", serviceId: "", templateId: "" },

  /* Only these accounts can open the admin view. Must match firestore.rules. */
  admins: ["admin@byld.ae", "accounts@byld.ae", "lcrllenado@gmail.com"],

  company: "BYLD Technical Services L.L.C",
  offDays: [5],          /* 5 = Friday. Days with no attendance expected. */
  defaultRadius: 300     /* metres from the site before a time-in is flagged */
};
