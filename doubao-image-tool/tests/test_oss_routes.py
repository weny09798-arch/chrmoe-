from license_fakes import PermittingAuthority
from app import create_app

def test_oss_config_api_protected_and_capability_does_not_expose_keys(tmp_path):
    app=create_app(lambda:None,tmp_path,token='t', license_authority=PermittingAuthority())
    try:
        with app.test_client() as c:
            assert c.get('/api/oss/config').status_code==403
            headers={'X-Tool-Token':'t'}
            config=dict(bucket='collector-test',region='cn-hangzhou',credential_mode='independent',access_key_id='test-id',access_key_secret='SECRET')
            result=c.post('/api/oss/config',headers=headers,json=config)
            assert result.status_code==200 and result.json['oss_configured']
            assert b'SECRET' not in result.data and b'access_key_id' not in result.data
            assert c.delete('/api/oss/config',headers=headers).json['oss_configured'] is False
    finally:app.extensions['queue'].close()

def test_oss_check_uses_configured_publisher(tmp_path):
    class Publisher:
        def check(self):return {'ok':True}
    app=create_app(lambda:None,tmp_path,token='t',oss_factory=lambda:Publisher(), license_authority=PermittingAuthority())
    try:
        with app.test_client() as c:
            assert c.post('/api/oss/check',headers={'X-Tool-Token':'t'}).json=={'ok':True}
    finally:app.extensions['queue'].close()
