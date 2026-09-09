[request url]
https://gmgn.ai/xapi/v1/bsc/flap/quote_support?device_id=0142c21d-44c5-4bb3-bbfc-7b220b5b2cd8&tab_id=mttc7lhjxodc&fp_did=599fadf2c4b60bf7984ade6b57701687&client_id=gmgn_web_20260908-4214-93ee0fd&from_app=gmgn&app_ver=20260908-4214-93ee0fd&tz_name=Asia_Shanghai&tz_offset=28800&app_lang=zh-CN&os=web&worker=0&token=0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff

[method]
Get

[response payload] yes
{
    "code": 0,
    "reason": "",
    "message": "success",
    "data": {
        "supported": true,
        "symbol": "4Stock",
        "name": "4Stock",
        "decimals": 18
    }
}

[response payload] no
{
    "code": 0,
    "reason": "",
    "message": "success",
    "data": {
        "supported": false,
        "symbol": "",
        "name": "",
        "decimals": 0
    }
}