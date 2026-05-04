// "use strict";

// const mongoose = require("mongoose");

// /**
//  * User model côté tx-core.
//  *
//  * IMPORTANT :
//  * - Ce modèle sert uniquement à LIRE les utilisateurs depuis la DB principale Users.
//  * - Il ne doit pas recopier toute la logique du backend principal.
//  * - Pas de hooks de chiffrement ici.
//  * - Pas de hash password ici.
//  * - Pas de validation lourde ici.
//  * - strict:false permet de lire les anciens/nouveaux champs sans casser.
//  * - autoIndex:false et autoCreate:false empêchent le tx-core de créer/modifier les indexes de la collection users.
//  */


// const userSchema = new mongoose.Schema(
//   {
//     fullName: {
//       type: String,
//       trim: true,
//       default: "",
//     },

//     email: {
//       type: String,
//       lowercase: true,
//       trim: true,
//       index: true,
//     },

//     phone: {
//       type: String,
//       trim: true,
//       default: "",
//       index: true,
//     },

//     country: {
//       type: String,
//       trim: true,
//       default: "",
//       index: true,
//     },

//     countryCode: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "",
//       index: true,
//     },

//     selectedCountry: {
//       type: String,
//       trim: true,
//       default: "",
//     },

//     residenceCountry: {
//       type: String,
//       trim: true,
//       default: "",
//     },

//     registrationCountry: {
//       type: String,
//       trim: true,
//       default: null,
//     },

//     nationality: {
//       type: String,
//       trim: true,
//       default: "",
//     },

//     currency: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "",
//       index: true,
//     },

//     currencyCode: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "",
//     },

//     defaultCurrency: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "",
//     },

//     managedCurrency: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: null,
//       index: true,
//     },

//     userType: {
//       type: String,
//       enum: ["individu", "entreprise", "system", "individual", "business"],
//       default: "individu",
//       index: true,
//     },

//     role: {
//       type: String,
//       default: "user",
//       index: true,
//     },

//     isBusiness: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     isSystem: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     systemType: {
//       type: String,
//       default: null,
//       index: true,
//     },

//     kycStatus: {
//       type: String,
//       enum: ["none", "pending", "verified", "rejected", ""],
//       default: "none",
//       index: true,
//     },

//     kybStatus: {
//       type: String,
//       enum: ["none", "pending", "verified", "rejected", "suspended", ""],
//       default: "none",
//       index: true,
//     },

//     accountStatus: {
//       type: String,
//       enum: ["active", "blocked", "frozen", "pending", ""],
//       default: "active",
//       index: true,
//     },

//     status: {
//       type: String,
//       trim: true,
//       default: "",
//       index: true,
//     },

//     staffStatus: {
//       type: String,
//       trim: true,
//       default: "",
//       index: true,
//     },

//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     deletedAt: {
//       type: Date,
//       default: null,
//     },

//     isBlocked: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     isLoginDisabled: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     hiddenFromTransfers: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     hiddenFromUserSearch: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     hiddenFromUserApp: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     profile: {
//       country: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       countryCode: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       currency: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       fullName: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       firstName: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       lastName: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       phone: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//     },

//     address: {
//       country: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       countryCode: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       city: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       region: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       line1: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       line2: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       postalCode: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//     },

//     kyc: {
//       status: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       verifiedCountry: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       verifiedCurrency: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       countryCode: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       verifiedAt: {
//         type: Date,
//         default: null,
//       },
//     },

//     kyb: {
//       status: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       verifiedCountry: {
//         type: String,
//         trim: true,
//         default: "",
//       },
//       verifiedCurrency: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       countryCode: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       verifiedAt: {
//         type: Date,
//         default: null,
//       },
//     },

//     wallet: {
//       currency: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//       defaultCurrency: {
//         type: String,
//         trim: true,
//         uppercase: true,
//         default: "",
//       },
//     },

//     balances: {
//       type: Map,
//       of: Number,
//       default: {},
//     },

//     mobiles: {
//       type: [
//         {
//           numero: {
//             type: String,
//             trim: true,
//           },
//           e164: {
//             type: String,
//             trim: true,
//           },
//           operator: {
//             type: String,
//             trim: true,
//           },
//           country: {
//             type: String,
//             trim: true,
//           },
//           isDeleted: {
//             type: Boolean,
//             default: false,
//           },
//         },
//       ],
//       default: [],
//     },

//     comptesBank: {
//       type: [
//         {
//           bankName: {
//             type: String,
//             trim: true,
//           },
//           holder: {
//             type: String,
//             trim: true,
//           },
//           iban: {
//             type: String,
//             trim: true,
//           },
//           bankCountry: {
//             type: String,
//             trim: true,
//           },
//           transitNumber: {
//             type: String,
//             trim: true,
//           },
//           institutionNumber: {
//             type: String,
//             trim: true,
//           },
//           isDeleted: {
//             type: Boolean,
//             default: false,
//           },
//         },
//       ],
//       default: [],
//     },

//     cartes: {
//       type: [
//         {
//           type: {
//             type: String,
//             trim: true,
//           },
//           holder: {
//             type: String,
//             trim: true,
//           },
//           expiry: {
//             type: String,
//             trim: true,
//           },
//           last4: {
//             type: String,
//             trim: true,
//           },
//           cardCountry: {
//             type: String,
//             trim: true,
//           },
//           binCountry: {
//             type: String,
//             trim: true,
//           },
//           isDeleted: {
//             type: Boolean,
//             default: false,
//           },
//         },
//       ],
//       default: [],
//     },
//   },
//   {
//     timestamps: true,
//     versionKey: "__v",
//     strict: false,
//     collection: "users",

//     /**
//      * Très important :
//      * le tx-core ne doit pas créer/modifier les indexes de la DB principale.
//      */
//     autoIndex: false,
//     autoCreate: false,

//     toJSON: {
//       virtuals: true,
//       transform(_doc, ret) {
//         delete ret.password;
//         delete ret.pinHash;
//         delete ret.refreshTokenHash;
//         delete ret.emailVerificationToken;
//         delete ret.phoneVerificationToken;
//         delete ret.passwordResetToken;
//         delete ret.twoFaSecret;
//         delete ret.twoFaTempSecret;
//         delete ret.backupCodes;

//         return ret;
//       },
//     },

//     toObject: {
//       virtuals: true,
//     },
//   }
// );

// module.exports = (conn = mongoose) => {
//   return conn.models.User || conn.model("User", userSchema);
// };






// File: src/models/User.js
"use strict";

const mongoose = require("mongoose");

/**
 * User model côté tx-core.
 *
 * IMPORTANT :
 * - Ce modèle sert uniquement à LIRE les utilisateurs depuis la DB principale Users.
 * - Il ne doit pas recopier toute la logique du backend principal.
 * - Pas de hooks de chiffrement ici.
 * - Pas de hash password ici.
 * - Pas de validation lourde ici.
 * - strict:false permet de lire les anciens/nouveaux champs sans casser.
 * - autoIndex:false et autoCreate:false empêchent le tx-core de créer/modifier les indexes de la collection users.
 */

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      trim: true,
      default: "",
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    country: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      index: true,
    },

    selectedCountry: {
      type: String,
      trim: true,
      default: "",
    },

    residenceCountry: {
      type: String,
      trim: true,
      default: "",
    },

    registrationCountry: {
      type: String,
      trim: true,
      default: null,
    },

    nationality: {
      type: String,
      trim: true,
      default: "",
    },

    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      index: true,
    },

    currencyCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },

    defaultCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },

    managedCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
      index: true,
    },

    userType: {
      type: String,
      enum: ["individu", "entreprise", "system", "individual", "business"],
      default: "individu",
      index: true,
    },

    role: {
      type: String,
      default: "user",
      index: true,
    },

    isBusiness: {
      type: Boolean,
      default: false,
      index: true,
    },

    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },

    systemType: {
      type: String,
      default: null,
      index: true,
    },

    isSandbox: {
      type: Boolean,
      default: false,
      index: true,
    },

    isReviewerAccount: {
      type: Boolean,
      default: false,
      index: true,
    },

    sandboxReason: {
      type: String,
      trim: true,
      default: null,
    },

    sandboxCreatedAt: {
      type: Date,
      default: null,
    },

    sandboxDisabledAt: {
      type: Date,
      default: null,
    },

    kycStatus: {
      type: String,
      enum: ["none", "pending", "verified", "rejected", ""],
      default: "none",
      index: true,
    },

    kybStatus: {
      type: String,
      enum: ["none", "pending", "verified", "rejected", "suspended", ""],
      default: "none",
      index: true,
    },

    accountStatus: {
      type: String,
      enum: ["active", "blocked", "frozen", "pending", ""],
      default: "active",
      index: true,
    },

    status: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    staffStatus: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    isBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },

    isLoginDisabled: {
      type: Boolean,
      default: false,
      index: true,
    },

    hiddenFromTransfers: {
      type: Boolean,
      default: false,
      index: true,
    },

    hiddenFromUserSearch: {
      type: Boolean,
      default: false,
      index: true,
    },

    hiddenFromUserApp: {
      type: Boolean,
      default: false,
      index: true,
    },

    profile: {
      country: {
        type: String,
        trim: true,
        default: "",
      },
      countryCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      currency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      fullName: {
        type: String,
        trim: true,
        default: "",
      },
      firstName: {
        type: String,
        trim: true,
        default: "",
      },
      lastName: {
        type: String,
        trim: true,
        default: "",
      },
      phone: {
        type: String,
        trim: true,
        default: "",
      },
    },

    address: {
      country: {
        type: String,
        trim: true,
        default: "",
      },
      countryCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      city: {
        type: String,
        trim: true,
        default: "",
      },
      region: {
        type: String,
        trim: true,
        default: "",
      },
      line1: {
        type: String,
        trim: true,
        default: "",
      },
      line2: {
        type: String,
        trim: true,
        default: "",
      },
      postalCode: {
        type: String,
        trim: true,
        default: "",
      },
    },

    kyc: {
      status: {
        type: String,
        trim: true,
        default: "",
      },
      verifiedCountry: {
        type: String,
        trim: true,
        default: "",
      },
      verifiedCurrency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      countryCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      verifiedAt: {
        type: Date,
        default: null,
      },
    },

    kyb: {
      status: {
        type: String,
        trim: true,
        default: "",
      },
      verifiedCountry: {
        type: String,
        trim: true,
        default: "",
      },
      verifiedCurrency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      countryCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      verifiedAt: {
        type: Date,
        default: null,
      },
    },

    wallet: {
      currency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      defaultCurrency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
    },

    balances: {
      type: Map,
      of: Number,
      default: {},
    },

    mobiles: {
      type: [
        {
          numero: {
            type: String,
            trim: true,
          },
          e164: {
            type: String,
            trim: true,
          },
          operator: {
            type: String,
            trim: true,
          },
          country: {
            type: String,
            trim: true,
          },
          isDeleted: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },

    comptesBank: {
      type: [
        {
          bankName: {
            type: String,
            trim: true,
          },
          holder: {
            type: String,
            trim: true,
          },
          iban: {
            type: String,
            trim: true,
          },
          bankCountry: {
            type: String,
            trim: true,
          },
          transitNumber: {
            type: String,
            trim: true,
          },
          institutionNumber: {
            type: String,
            trim: true,
          },
          isDeleted: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },

    cartes: {
      type: [
        {
          type: {
            type: String,
            trim: true,
          },
          holder: {
            type: String,
            trim: true,
          },
          expiry: {
            type: String,
            trim: true,
          },
          last4: {
            type: String,
            trim: true,
          },
          cardCountry: {
            type: String,
            trim: true,
          },
          binCountry: {
            type: String,
            trim: true,
          },
          isDeleted: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: "__v",
    strict: false,
    collection: "users",

    autoIndex: false,
    autoCreate: false,

    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.password;
        delete ret.pinHash;
        delete ret.pinCodeHash;
        delete ret.refreshTokenHash;
        delete ret.emailVerificationToken;
        delete ret.phoneVerificationToken;
        delete ret.passwordResetToken;
        delete ret.twoFaSecret;
        delete ret.twoFaTempSecret;
        delete ret.backupCodes;

        return ret;
      },
    },

    toObject: {
      virtuals: true,
    },
  }
);

module.exports = (conn = mongoose) => {
  return conn.models.User || conn.model("User", userSchema);
};