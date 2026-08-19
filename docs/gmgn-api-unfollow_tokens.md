[request url]
https://gmgn.ai/api/v1/follow_token/token/unfollow_tokens?device_id=d9cec3df-7266-4afc-8bce-8cb23bd845e4&fp_did=efe1dbb084fdf8e1ef23dd4e8cd53c99&client_id=gmgn_web_20260816-3390-f1ac972&from_app=gmgn&app_ver=20260816-3390-f1ac972&tz_name=Asia%2FHong_Kong&tz_offset=28800&app_lang=zh-CN&os=web&worker=0

[method]
POST

[request payload]
{
    "tokens": [
        {
            "token_address": "0x964ad8b6ab3261b6134b2c1440a9712a3d457777",
            "group_id": "all_group"
        }
    ],
    "chain": "bsc"
}

[response payload]
{
    "code": 0,
    "reason": "",
    "message": "success",
    "data": {
        "chain": "bsc",
        "tokens": [
            {
                "group_id": "all_group",
                "token_address": "0x964ad8b6ab3261b6134b2c1440a9712a3d457777"
            }
        ]
    }
}