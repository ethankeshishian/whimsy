/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/parity: Arc's deterministic tidy-title rules (its tidyTitles
// config: 52 hosts), as Arc ships them (arc-ref/behaviors.md). Generated;
// patterns are kept exactly as Arc wrote them.

export const TIDY_TITLES = {
  "linkedin.com": {
    "siteName": "LinkedIn",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "LinkedIn"
        }
      },
      {
        "match": {
          "pathEquals": "/feed"
        },
        "title": {
          "always": "LinkedIn"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/.+"
        },
        "title": {
          "removingPatterns": [
            " [\\|] LinkedIn$",
            "^\\([0-9]+\\+?\\)\\s"
          ]
        }
      }
    ]
  },
  "mail.google.com": {
    "siteName": "Gmail",
    "rules": [
      {
        "match": {
          "fragmentEquals": "inbox"
        },
        "title": {
          "always": "Gmail"
        }
      },
      {
        "match": {
          "fragmentEquals": "starred"
        },
        "title": {
          "always": "Starred"
        }
      },
      {
        "match": {
          "fragmentEquals": "snoozed"
        },
        "title": {
          "always": "Snoozed"
        }
      },
      {
        "match": {
          "fragmentEquals": "sent"
        },
        "title": {
          "always": "Sent"
        }
      },
      {
        "match": {
          "fragmentEquals": "drafts"
        },
        "title": {
          "always": "Drafts"
        }
      },
      {
        "match": {
          "fragmentEquals": "imp"
        },
        "title": {
          "always": "Important"
        }
      },
      {
        "match": {
          "fragmentEquals": "scheduled"
        },
        "title": {
          "always": "Scheduled"
        }
      },
      {
        "match": {
          "fragmentEquals": "all"
        },
        "title": {
          "always": "All"
        }
      },
      {
        "match": {
          "fragmentEquals": "spam"
        },
        "title": {
          "always": "Spam"
        }
      },
      {
        "match": {
          "fragmentEquals": "trash"
        },
        "title": {
          "always": "Trash"
        }
      },
      {
        "match": {
          "fragmentContainsRegex": "^label/.+"
        },
        "title": {
          "removingPattern": " - .+$"
        }
      }
    ]
  },
  "gmail.com": {
    "siteName": "Gmail",
    "rules": [
      {
        "title": {
          "always": "Gmail"
        }
      }
    ]
  },
  "calendar.google.com": {
    "siteName": "Calendar",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "/r/eventedit"
        },
        "title": {
          "removingPattern": ".+Calendar - "
        }
      },
      {
        "match": {
          "pathContainsRegex": "/r/agenda"
        },
        "title": {
          "always": "Schedule"
        }
      },
      {
        "match": {
          "pathContainsRegex": "/r/."
        },
        "title": {
          "removingPattern": ".+Calendar - "
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/calendar/u/[0-9]+"
        },
        "title": {
          "always": "Calendar"
        }
      }
    ]
  },
  "amazon.com": {
    "siteName": "Amazon",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Amazon"
        }
      },
      {
        "match": {
          "pathContainsRegex": "/.+"
        },
        "title": {
          "removingPattern": "^(Amazon.com[\\s]?:?[\\.]?[\\s])?"
        }
      },
      {
        "title": {
          "removingPattern": "^Amazon.com\\.? ?:? ?"
        }
      }
    ]
  },
  "news.ycombinator.com": {
    "siteName": "Hacker News",
    "rules": [
      {
        "title": {
          "removingPattern": " \\| Hacker News$"
        }
      }
    ]
  },
  "figma.com": {
    "siteName": "Figma",
    "rules": [
      {
        "match": {
          "pathEquals": "/files/recent"
        },
        "title": {
          "always": "Recently Viewed"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/files/.+"
        },
        "title": {
          "removingPattern": " – Figma$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/file/.+"
        },
        "title": {
          "removingPattern": " – Figma$"
        }
      },
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Figma"
        }
      }
    ]
  },
  "browserinc.notion.site": {
    "siteName": "Notion",
    "rules": [
      {
        "match": {
          "pathEquals": "/Arc-Resources-e5dfd3226b2544b0816f6778b32fc6a4"
        },
        "title": {
          "always": "Arc Resources"
        }
      },
      {
        "match": {
          "pathEquals": "/Shortcuts-500ec3b2118b4824986427c32d2aba7e"
        },
        "title": {
          "always": "Shortcuts"
        }
      }
    ]
  },
  "notion.so": {
    "siteName": "Notion",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Notion"
        }
      },
      {
        "title": {
          "removingPatterns": [
            "^\\([0-9]+\\+?\\)\\s",
            " \\| Notion$",
            " – The all-in-one workspace for your notes, tasks, wikis, and databases."
          ]
        }
      }
    ]
  },
  "app.notion.com": {
    "siteName": "Notion",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Notion"
        }
      },
      {
        "title": {
          "removingPatterns": [
            "^\\([0-9]+\\+?\\)\\s",
            " \\| Notion$",
            " – The all-in-one workspace for your notes, tasks, wikis, and databases."
          ]
        }
      }
    ]
  },
  "en.wikipedia.org": {
    "siteName": "Wikipedia",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/wiki/Main_Page"
        },
        "title": {
          "always": "Wikipedia"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/wiki/.+"
        },
        "title": {
          "removingPattern": " - Wikipedia$"
        }
      }
    ]
  },
  "twitter.com": {
    "siteName": "Twitter",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Twitter"
        }
      },
      {
        "match": {
          "pathEquals": "/home"
        },
        "title": {
          "always": "Twitter"
        }
      },
      {
        "title": {
          "removingPatterns": [
            " / Twitter$",
            "^\\([0-9]+\\+?\\)\\s",
            " on Twitter",
            " - Twitter Search$"
          ]
        }
      }
    ]
  },
  "drive.google.com": {
    "siteName": "Google Drive",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/drive/u/"
        },
        "title": {
          "removingPattern": " - Google Drive$"
        }
      }
    ]
  },
  "docs.google.com": {
    "siteName": "Google Docs",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/spreadsheets/d/.+"
        },
        "title": {
          "removingPattern": " - Google Sheets$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/document/d/.+"
        },
        "title": {
          "removingPattern": " - Google Docs$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/presentation/d/.+"
        },
        "title": {
          "removingPattern": " - Google Slides$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/forms/d/.+"
        },
        "title": {
          "removingPattern": " - Google Forms$"
        }
      }
    ]
  },
  "spreadsheets.google.com": {
    "siteName": "Google Sheets",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/spreadsheets/d/.+"
        },
        "title": {
          "removingPattern": " - Google Sheets$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/forms/d/.+"
        },
        "title": {
          "removingPattern": " - Google Forms$"
        }
      }
    ]
  },
  "zillow.com": {
    "siteName": "Zillow",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Zillow"
        }
      }
    ]
  },
  "npr.org": {
    "siteName": "NPR",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "NPR"
        }
      }
    ]
  },
  "google.com": {
    "siteName": "Google Search",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/search"
        },
        "title": {
          "removingPattern": " - Google Search$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/gmail/about"
        },
        "title": {
          "always": "Gmail"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/maps/place"
        },
        "title": {
          "removingPattern": " - Google Maps$"
        }
      }
    ]
  },
  "app.slack.com": {
    "siteName": "Slack",
    "rules": [
      {
        "title": {
          "removingPatterns": [
            "^Slack \\| ",
            " \\| [0-9]+ new items?"
          ]
        }
      }
    ]
  },
  "robinhood.com": {
    "siteName": "Robinhood",
    "rules": [
      {
        "title": {
          "removingPattern": " \\| Robinhood$"
        }
      }
    ]
  },
  "justworks.com": {
    "siteName": "Justworks",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Justworks"
        }
      }
    ]
  },
  "secure.justworks.com": {
    "siteName": "Justworks",
    "rules": [
      {
        "match": {
          "pathEquals": "/directory/org_chart"
        },
        "title": {
          "always": "Org Chart"
        }
      },
      {
        "match": {
          "pathEquals": "/directory"
        },
        "title": {
          "always": "Directory"
        }
      },
      {
        "match": {
          "pathEquals": "/calendar"
        },
        "title": {
          "always": "Calendar"
        }
      },
      {
        "match": {
          "pathEquals": "/vouchers"
        },
        "title": {
          "always": "Paystubs"
        }
      },
      {
        "match": {
          "pathEquals": "/my_benefits"
        },
        "title": {
          "always": "Benefits"
        }
      },
      {
        "match": {
          "pathEquals": "/documents"
        },
        "title": {
          "always": "Documents"
        }
      },
      {
        "match": {
          "pathEquals": "/training"
        },
        "title": {
          "always": "Training"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/account_settings"
        },
        "title": {
          "always": "Settings"
        }
      }
    ]
  },
  "dropbox.com": {
    "siteName": "Dropbox",
    "rules": [
      {
        "title": {
          "removingPattern": " - Dropbox$"
        }
      }
    ]
  },
  "maps.google.com": {
    "siteName": "Google Maps",
    "rules": [
      {
        "title": {
          "removingPattern": " - Google Maps$"
        }
      }
    ]
  },
  "open.spotify.com": {
    "siteName": "Spotify",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Spotify"
        }
      },
      {
        "title": {
          "removingPatterns": [
            " – Web Player$",
            "^Spotify – "
          ]
        }
      }
    ]
  },
  "meet.google.com": {
    "siteName": "Google Meet",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/[a-z]+-[a-z]+-[a-z]+$"
        },
        "title": {
          "removingPattern": "^Meet - "
        }
      }
    ]
  },
  "weather.com": {
    "siteName": "Weather.com",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Weather.com"
        }
      }
    ]
  },
  "booooooom.com": {
    "siteName": "BOOOOOOOOM",
    "rules": [
      {
        "match": {
          "pathEquals": "/blog/art"
        },
        "title": {
          "always": "Art – BOOOOOOOM!"
        }
      }
    ]
  },
  "nytimes.com": {
    "siteName": "The New York Times",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/(live/)?[0-9]{4}/.+"
        },
        "title": {
          "removingPattern": " - The New York Times$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "/crosswords(/.+)?"
        },
        "title": {
          "removingPattern": " ?- The New York Times$"
        }
      },
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "removingPattern": " - Breaking News, US News, World News and Videos$"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/(puzzles|games)/.+"
        },
        "title": {
          "removingPatterns": [
            " ?- The New York Times",
            " - New York Times Number Puzzles"
          ]
        }
      },
      {
        "match": {
          "pathEquals": "/crosswords"
        },
        "title": {
          "removingPattern": "- The New York Times.+$"
        }
      }
    ]
  },
  "cooking.nytimes.com": {
    "siteName": "NYT Cooking",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/.+"
        },
        "title": {
          "removingPattern": " - NYT Cooking"
        }
      },
      {
        "match": {
          "pathContainsRegex": "/"
        },
        "title": {
          "always": "NYT Cooking"
        }
      }
    ]
  },
  "github.com": {
    "siteName": "GitHub",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/.+/pull/[0-9]+"
        },
        "title": {
          "removingPattern": "\\s+by\\s+[a-zA-Z0-9_.-]+\\s+·.*"
        }
      }
    ]
  },
  "docs.github.com": {
    "siteName": "GitHub Docs",
    "rules": [
      {
        "title": {
          "removingPattern": " - GitHub Docs$"
        }
      }
    ]
  },
  "aws.amazon.com": {
    "siteName": "Amazon Web Services",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Amazon Web Services"
        }
      }
    ]
  },
  "us02web.zoom.us": {
    "siteName": "Zoom",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "^/.+"
        },
        "title": {
          "always": "Launch Meeting"
        }
      }
    ]
  },
  "disneyplus.com": {
    "siteName": "Disney+",
    "rules": [
      {
        "match": {
          "pathContainsRegex": "/(home/)?"
        },
        "title": {
          "always": "Disney+"
        }
      }
    ]
  },
  "reddit.com": {
    "siteName": "Reddit",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Reddit"
        }
      },
      {
        "match": {
          "pathContainsRegex": "^/.+"
        },
        "title": {
          "removingPattern": "\\([0-9]+\\) "
        }
      }
    ]
  },
  "youtube.com": {
    "siteName": "YouTube",
    "rules": [
      {
        "title": {
          "removingPattern": " - YouTube"
        }
      }
    ]
  },
  "docusign.com": {
    "siteName": "DocuSign",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "DocuSign"
        }
      }
    ]
  },
  "miro.com": {
    "siteName": "Miro",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Miro"
        }
      },
      {
        "title": {
          "removingPattern": " ?(,|\\|) Online Whiteboard for Visual Collaboration"
        }
      }
    ]
  },
  "hulu.com": {
    "siteName": "Hulu",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Hulu"
        }
      },
      {
        "match": {
          "pathEquals": "/hub/home"
        },
        "title": {
          "always": "Hulu"
        }
      },
      {
        "title": {
          "removingPattern": "^Hulu \\| "
        }
      }
    ]
  },
  "lever.co": {
    "siteName": "Lever",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Lever"
        }
      },
      {
        "title": {
          "removingPattern": " \\|.+$"
        }
      }
    ]
  },
  "hire.lever.co": {
    "siteName": "Lever Hire",
    "rules": [
      {
        "title": {
          "removingPattern": " – Lever Hire"
        }
      }
    ]
  },
  "admin.typeform.com": {
    "siteName": "Typeform",
    "rules": [
      {
        "title": {
          "removingPattern": "^Typeform - "
        }
      }
    ]
  },
  "typeform.com": {
    "siteName": "Typeform",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Typeform"
        }
      }
    ]
  },
  "netflix.com": {
    "siteName": "Netflix",
    "rules": [
      {
        "title": {
          "removingPattern": " - Netflix$"
        }
      }
    ]
  },
  "airtable.com": {
    "siteName": "Airtable",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Airtable"
        }
      },
      {
        "title": {
          "removingPatterns": [
            "^Airtable - ",
            " - Airtable$"
          ]
        }
      }
    ]
  },
  "app.front.com": {
    "siteName": "Front",
    "rules": [
      {
        "match": {
          "pathEquals": "/"
        },
        "title": {
          "always": "Front"
        }
      }
    ]
  },
  "ft.com": {
    "siteName": "Financial Times",
    "rules": [
      {
        "title": {
          "removingPattern": " \\| Financial Times"
        }
      }
    ]
  },
  "app.mode.com": {
    "siteName": "Mode",
    "rules": [
      {
        "title": {
          "removingPattern": " \\| Mode$"
        }
      }
    ]
  },
  "console.cloud.google.com": {
    "siteName": "Google Cloud console",
    "rules": [
      {
        "title": {
          "removingPattern": " \\– Google Cloud console$"
        }
      }
    ]
  },
  "aa.com": {
    "siteName": "American Airlines",
    "rules": [
      {
        "match": {
          "pathEquals": "^/homePage.do"
        },
        "title": {
          "always": "American Airlines"
        }
      },
      {
        "title": {
          "removingPattern": " -.+"
        }
      }
    ]
  },
  "web.whatsapp.com": {
    "siteName": "WhatsApp",
    "rules": [
      {
        "title": {
          "always": "WhatsApp"
        }
      }
    ]
  }
};
