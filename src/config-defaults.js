// 配置默认值：schema 与 config.example.json 的唯一来源。
// 来源 = loadConfig() 的代码默认值 ∪ 完整配置模板（缺省键补全）。
// 修改默认值请改这里，然后运行 `npm run gen:config` 重新生成模板。
export const CONFIG_DEFAULTS = {
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "deepseek-official",
    "model": "deepseek-v4-flash-vision-exp",
    "reasoningEffort": "max"
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "accessToken": "",
    "httpUrl": "http://127.0.0.1:3000",
    "launcherPath": "C:\\path\\to\\SnowLuma\\launcher.bat",
    "homeDir": "C:\\path\\to\\SnowLuma",
    "allowProcessControl": false
  },
  "sessionCwd": "",
  "agentPreset": "qq-chat",
  "workspaceTitle": "QQ 聊天",
  "ownerQQ": null,
  "allow": {
    "private": [],
    "groups": [],
    "privateMode": "list"
  },
  "deny": {
    "private": [],
    "groups": []
  },
  "allowAllWhenEmpty": false,
  "ackMessage": "🤔 收到，正在思考…",
  "sendDelayMs": 300,
  "questionTimeoutMs": 300000,
  "consolePort": 3100,
  "consoleAuth": true,
  "consoleToken": "",
  "security": {
    "interceptNotify": true
  },
  "errorNotify": {
    "notifyOwner": true,
    "windowMs": 180000
  },
  "slang": {
    "enabled": true,
    "extractMinMessages": 10,
    "extractCooldownMs": 300000,
    "inferenceThresholds": [
      2,
      4,
      8
    ],
    "injectMax": 8,
    "learnerPreset": "qq-chat",
    "workspaceTitle": "QQ 黑话学习",
    "autoResearch": true
  },
  "social": {
    "enabled": true,
    "triggerProbability": 0.1,
    "contextWindow": 20,
    "activeCheckMinMs": 10000,
    "activeCheckMaxMs": 30000,
    "activeReplyDelayMinMs": 2000,
    "activeReplyDelayMaxMs": 8000,
    "activeDurationEnabled": true,
    "activeDurationMinMs": 900000,
    "activeDurationMaxMs": 1800000,
    "idleWindowMs": 360000,
    "idleRetryProbability": 0.25,
    "idleRetryWaitMs": 120000,
    "proactiveEnabled": true,
    "proactiveIdleThresholdMs": 1800000,
    "proactiveCheckMinMs": 2700000,
    "proactiveCheckMaxMs": 5400000,
    "proactiveProbability": 0.2,
    "skipProbability": 0.15,
    "surrenderProbability": 0,
    "maxReplyChars": 500,
    "mustReplyKeywords": [
      "deepseek",
      "小鲸鱼",
      "大肥鱼",
      "鲸鱼",
      "d指导",
      "在吗"
    ],
    "burstEnabled": true,
    "burstIntervalMinMs": 1000,
    "burstIntervalMaxMs": 3000,
    "longGapProbability": 0.1,
    "longGapMinMs": 2500,
    "longGapMaxMs": 5000
  },
  "socialV2": {
    "enabled": true,
    "autoReplyCheckMs": 30000,
    "agentPreset": "qq-chat-v2",
    "provideRecommendations": true,
    "tools": {
      "getPrompt": true,
      "getUnread": true,
      "getRecent": true,
      "socialState": true,
      "sendGroup": true,
      "sendPrivate": true,
      "reply": true,
      "sendBurst": true,
      "sendMessage": true,
      "waitMessages": true,
      "feedback": true,
      "getMyRecent": true,
      "getMessageDetail": true,
      "getActiveMembers": true,
      "setWakeConfig": true,
      "markRead": true,
      "memory": true,
      "slangQuery": true,
      "slangSubmit": true,
      "getImages": true,
      "getForwardMsg": true,
      "sendPoke": true,
      "sendImage": true,
      "checkImage": true,
      "refreshImageLib": true,
      "listStickers": true,
      "getStickerImage": true,
      "sendSticker": true,
      "setStickerRemark": false,
      "stickerNote": true,
      "collectSticker": true,
      "getSelfImage": true,
      "getFeatureMenu": true,
      "reverseSearch": true,
      "tokenReport": true,
      "sendVoice": true,
      "deleteSticker": false,
      "groupFiles": true,
      "githubShot": true,
      "crawl": true,
      "fetchXPosts": true,
      "reactMessage": true,
      "rejectImage": true,
      "archiveImage": true,
      "imageSource": true,
      "upscaleImage": true,
      "sendFeatureMenu": true,
      "watchBili": true,
      "biliRecord": true,
      "biliMemory": true,
      "biliSearch": true,
      "qq_status": true,
      "qq_list_groups": true,
      "qq_get_group_members": true,
      "qq_get_group_history": true,
      "recallMemory": true
    },
    "wake": {
      "defaultMode": "diving",
      "preSleepWaitEnabled": true,
      "preSleepWaitMs": 300000,
      "recommendedDefaultInfinite": true,
      "sleepMinMs": 60000,
      "sleepMaxMs": 0,
      "recommendedSleepMinMs": 300000,
      "recommendedSleepMaxMs": 7200000,
      "recommendedProbability": 0.05,
      "recommendedKeywords": [
        "小鲸鱼",
        "DeepSeek",
        "deepseek",
        "DS",
        "D老师",
        "d老师",
        "D指导",
        "d指导",
        "D师傅",
        "d师傅",
        "深度求索",
        "大肥鱼",
        "鲸鱼",
        "DeepSeek V3",
        "DeepSeek R1",
        "R1"
      ],
      "recommendedAtMention": true,
      "recommendedNameMention": true,
      "recommendedQuestion": true,
      "recommendedPoke": true,
      "recommendedHint": "如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。",
      "batchWindowMs": 8000,
      "maxWakePerMinute": 1,
      "maxWakePerHour": 12,
      "noActionLimit": 3,
      "maxWakeConfigReminders": 2,
      "preSleepReplyGraceMs": 30000
    },
    "send": {
      "burstEnabled": true,
      "burstMaxMessages": 8,
      "burstIntervalMinMs": 1000,
      "burstIntervalMaxMs": 3000,
      "longGapProbability": 0.2,
      "longGapMinMs": 5000,
      "longGapMaxMs": 10000,
      "maxSendPerMinute": 8,
      "maxSendPerHour": 60,
      "maxMessageChars": 500,
      "maxGapMs": 10000,
      "gapBaseMs": 800,
      "gapPerCharMs": 20,
      "recommendedHint": "普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。",
      "autoAt": {
        "enabled": true,
        "probability": 0.3,
        "windowMs": 600000,
        "cooldownMs": 300000,
        "maxPerHour": 10,
        "staleAfterMs": 3600000,
        "minOverlap": 0.12,
        "backwardMinGrams": 8,
        "addressedTtlMs": 120000
      }
    },
    "wait": {
      "defaultMs": 30000,
      "minMs": 5000,
      "maxMs": 600000,
      "defaultQuietMs": 8000,
      "minQuietAfterNewMs": 10000,
      "maxQuietMs": 15000,
      "turnMaxCount": 2,
      "turnMaxMs": 120000
    },
    "sticker": {
      "enabled": true,
      "syncTtlMs": 60000,
      "maxListCount": 100,
      "includeInPrompt": true,
      "promptMaxStickers": 8,
      "autoNudge": true,
      "autoNudgeProbability": 0.33,
      "autoNudgeMinGapMs": 180000,
      "autoNudgeMaxPerHour": 6,
      "autoNudgeCandidates": 3,
      "collect": {
        "enabled": true,
        "maxPerMinute": 2,
        "maxPerHour": 10,
        "maxRemarkChars": 20,
        "maxUploadBytes": 4194304
      },
      "readLocalCache": true
    },
    "crawl": {
      "enabled": true,
      "maxPerHour": 10,
      "maxImages": 10,
      "maxStickersPerCall": 3,
      "stickerMaxPerDay": 20,
      "maxBytes": 5242880,
      "timeoutMs": 30000
    },
    "proactive": {
      "enabled": true,
      "checkIntervalMinMs": 1800000,
      "checkIntervalMaxMs": 5400000,
      "idleThresholdMs": 900000,
      "probability": 0.3
    },
    "feedback": {
      "maxLength": 500,
      "notifyOwnerOnError": false
    },
    "context": {
      "recentLimit": 100,
      "unreadLimit": 30,
      "contextWindow": 20
    },
    "contextMemory": {
      "enabled": true,
      "episodeEveryMessages": 40,
      "episodeIdleMs": 1200000,
      "episodeIdleMinMessages": 15,
      "episodeInputLimit": 60,
      "episodeKeep": 300,
      "compactionKeep": 20,
      "journalKeep": 3000,
      "journalCompactBytes": 2097152,
      "longTermKeepPeople": 30,
      "longTermKeepFacts": 80,
      "longTermKeepThreads": 40,
      "sweepMaxPerRun": 6,
      "sweepChunksPerKey": 2,
      "sweepMaxEpisodesPerRun": 12,
      "sweepActiveWithinMs": 604800000,
      "memoryPackChars": 1500,
      "promptBudgetChars": 20000,
      "promptMaxChars": 6000,
      "backlogWarnMessages": 200,
      "backlogCriticalMessages": 800,
      "backlogHistoryKeep": 288,
      "recallAuditKeep": 200,
      "gatewayUrl": "http://127.0.0.1:7863/v1",
      "model": "cn:deepseek-v4.1-flash",
      "apiKey": "",
      "timeoutMs": 60000
    },
    "comply": {
      "enabled": true,
      "probability": 0.7,
      "ttlMs": 180000,
      "cooldownMs": 20000,
      "maxPerHour": 12
    },
    "gifFrames": {
      "enabled": true,
      "maxFrames": 20,
      "tileWidth": 320,
      "timeoutMs": 15000
    },
    "media": {
      "maxMessageBytes": 8388608
    },
    "images": {
      "enabled": false,
      "libDir": "",
      "maxFiles": 300,
      "maxTotalBytes": 268435456,
      "maxBytesPerFile": 8388608,
      "fetchPerRun": 20,
      "ondemandFetchCount": 4,
      "cooldownMs": 1800000,
      "sendCooldownMs": 20000,
      "maxSendPerHour": 10,
      "annotateSource": true,
      "sentTtlMs": 600000,
      "sentSweepMs": 60000,
      "feedbackSwap": true,
      "feedbackWindowMs": 120000,
      "feedbackCooldownMs": 90000,
      "archiveDir": "E:\\tmp\\collected",
      "archiveOverwrite": false,
      "sources": {
        "safebooru": {
          "enabled": true,
          "tags": [],
          "limit": 20
        },
        "pixiv": {
          "enabled": false,
          "limit": 20,
          "authFile": "state/pixiv-auth.json",
          "proxy": ""
        },
        "yandere": {
          "enabled": false,
          "limit": 20,
          "proxy": ""
        }
      },
      "recentSendBlockMs": 600000,
      "proxy": ""
    },
    "githubShot": {
      "enabled": true,
      "sliceHeight": 2400,
      "maxHeight": 12000,
      "waitMs": 3500,
      "timeoutMs": 90000,
      "proxy": ""
    },
    "joinRequest": {
      "enabled": true,
      "autoApprove": false,
      "ttlMs": 300000,
      "notifyChannel": "private"
    },
    "whitelistNotice": {
      "enabled": true,
      "cooldownMs": 600000,
      "messages": []
    },
    "emojiReact": {
      "enabled": true,
      "cooldownMs": 60000,
      "maxPerHour": 15,
      "emojis": [
        {
          "id": "76",
          "name": "赞",
          "use": "同意、支持"
        },
        {
          "id": "124",
          "name": "OK",
          "use": "收到、没问题、认可"
        },
        {
          "id": "201",
          "name": "点赞",
          "use": "比\"赞\"更活泼的赞同"
        },
        {
          "id": "364",
          "name": "超级赞",
          "use": "非常赞同"
        },
        {
          "id": "20",
          "name": "偷笑",
          "use": "好笑但不想打字"
        },
        {
          "id": "13",
          "name": "呲牙",
          "use": "开心、乐"
        },
        {
          "id": "5",
          "name": "流泪",
          "use": "笑到流泪 / 也被用来说\"感动\""
        },
        {
          "id": "12",
          "name": "调皮",
          "use": "开玩笑、逗"
        },
        {
          "id": "16",
          "name": "酷",
          "use": "帅气、厉害"
        },
        {
          "id": "21",
          "name": "可爱",
          "use": "萌、可爱"
        },
        {
          "id": "66",
          "name": "爱心",
          "use": "喜欢、比心"
        },
        {
          "id": "63",
          "name": "玫瑰",
          "use": "送花、感谢"
        },
        {
          "id": "99",
          "name": "鼓掌",
          "use": "叫好、祝贺"
        },
        {
          "id": "79",
          "name": "胜利",
          "use": "成功、赢了"
        },
        {
          "id": "0",
          "name": "惊讶",
          "use": "没想到"
        },
        {
          "id": "3",
          "name": "发呆",
          "use": "懵、无语但不冒犯"
        }
      ]
    },
    "errorNotice": {
      "enabled": true,
      "windowMs": 180000,
      "notifyOwner": true,
      "inGroup": false,
      "messages": [
        "诶，我这边好像没额度了……让管理员看看？",
        "呀，卡住了，好像是没额度了呢",
        "呜，我这会儿转不动了，管理员救一下",
        "诶诶，我掉线了…应该又没额度了吧",
        "本鱼没电了，管理员你在吗"
      ]
    },
    "upscale": {
      "enabled": true,
      "model": "upscayl-standard-4x",
      "binDir": "",
      "modelDir": "",
      "timeoutMs": 120000,
      "cache": {
        "enabled": true,
        "dir": "",
        "maxAgeDays": 3,
        "maxBytes": 524288000,
        "sweepEveryHours": 6
      }
    },
    "bili": {
      "enabled": true,
      "selfBrowsing": {
        "enabled": true,
        "dailyBudgetSec": 7200,
        "minIntervalMs": 300000,
        "maxIntervalMs": 600000,
        "maxSecondsPerVideo": 240,
        "framesPerSecond": 1,
        "maxFramesTotal": 120,
        "tilesPerSheet": 30,
        "framesDisliked": 8,
        "framesLiked": 36,
        "seenCooldownMs": 604800000,
        "onlyWhenDiving": true,
        "categoryWeights": {
          "二次元": 6,
          "游戏": 5,
          "科技": 4,
          "社会热点": 3.5,
          "知识": 3,
          "鬼畜": 2,
          "音乐": 1.5,
          "生活": 1,
          "搞笑": 1,
          "影视": 1
        },
        "scanSeconds": 6,
        "likedSeconds": 120,
        "judgeTimeoutMs": 150000,
        "gameBoost": 20,
        "preferGames": true,
        "poolPages": 3,
        "search": {
          "enabled": true,
          "maxKeywords": 6,
          "count": 20,
          "order": "totalrank",
          "gamesOnly": false
        }
      },
      "share": {
        "enabled": true,
        "minInterest": 65,
        "probability": 0.3,
        "minGapMs": 21600000,
        "askModel": true,
        "preferActiveGroups": true,
        "activeWindowHours": 24,
        "minActivityForShare": 1,
        "activityWeightCap": 120
      },
      "watchShared": {
        "enabled": true,
        "seconds": 10,
        "frames": 12,
        "cooldownMs": 600000
      },
      "memory": {
        "file": "state/bili-memory.json",
        "maxItems": 800
      },
      "authFile": "state/bili-auth.json"
    },
    "tts": {
      "enabled": false,
      "dir": "",
      "probability": 0.15,
      "maxPerHour": 60,
      "maxChars": 140,
      "device": "cuda",
      "isHalf": true,
      "voiceName": "",
      "timeoutMs": 180000,
      "gptModel": "",
      "sovitsModel": "",
      "cpuThreads": 8,
      "voiceId": "",
      "weightsId": "proplus",
      "refMode": "auto",
      "speed": 1,
      "fragmentInterval": 0.3,
      "temperature": 0.8,
      "topK": 15,
      "topP": 0.95,
      "textSplitMethod": "cut5",
      "volumeGainDb": 0,
      "punctuate": true
    },
    "sharedMemory": {
      "enabled": true,
      "shareProfiles": true,
      "includePrivate": true,
      "excludeKeys": [],
      "maxPeople": 2000,
      "maxTraitsPerPerson": 20,
      "maxPromptPeople": 3,
      "maxPromptTraits": 3,
      "maxPromptChars": 300,
      "ttlDays": 180,
      "identityTtlDays": 365
    },
    "tokenFuse": {
      "enabled": true,
      "warnTokens": 1000000000,
      "fuseTokens": 2000000000,
      "fuseUncachedTokens": 300000000,
      "resetOnNewDay": true,
      "overrides": {}
    },
    "gapNotice": {
      "enabled": false,
      "gapMinutes": 30,
      "longGapHours": 6
    }
  },
  "imageReverseSearch": {
    "enabled": true,
    "apiKey": "",
    "db": 999,
    "minsim": 50,
    "numres": 5,
    "proxy": ""
  },
  "webSearch": {
    "enabled": true,
    "engines": [
      "weather",
      "baidu",
      "bing-html",
      "bing-rss",
      "duckduckgo"
    ],
    "maxResults": 8,
    "timeoutMs": 12000,
    "totalTimeoutMs": 35000,
    "proxy": ""
  },
  "xMonitor": {
    "proxy": "",
    "translate": true,
    "gatewayUrl": "",
    "translateModel": "",
    "maxCount": 5,
    "scanLimit": 12,
    "includeMedia": true,
    "mediaDir": "state/x-monitor-media",
    "mediaTtlMs": 7200000,
    "mediaSweepMs": 300000,
    "mediaMaxBytes": 209715200,
    "mediaMaxFiles": 400,
    "ownOnly": true,
    "includeVideo": true,
    "maxVideoBytes": 104857600,
    "review": {
      "enabled": false,
      "mode": "warn",
      "failClosed": true,
      "maxChars": 4000,
      "timeoutMs": 8000,
      "keywordsByCategory": {},
      "blockedDomains": [],
      "auditFile": "state/x-monitor/review-audit.jsonl",
      "auditMaxEntries": 2000
    }
  }
};

export default CONFIG_DEFAULTS;
