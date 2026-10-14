"""Paired bridge routes; authorization and CORS belong to bridge_routes."""
from flask import request, jsonify, Response

def register_selling_routes(app,service,credentials):
    def body(keys):
        value=request.get_json(silent=True)
        if not isinstance(value,dict) or set(value)!=set(keys):raise ValueError('請求欄位無效，請重新載入')
        return value

    @app.route('/api/bridge/settings/bailian',methods=['GET','POST','DELETE'])
    def bailian_settings():
        if request.method=='POST':credentials.save(**body({'api_key','workspace_id'}))
        elif request.method=='DELETE':
            if request.get_data():body(set())
            credentials.delete()
        elif request.get_data():body(set())
        return jsonify(credentials.status())

    @app.post('/api/bridge/selling-points/jobs')
    def selling_create():
        if set(request.files)!={'image'} or not set(request.form).issubset({'product_name','facts'}):raise ValueError('請上傳一張原圖並填寫商品資料')
        image=request.files['image']
        return jsonify(service.create(image.filename or '',image.stream.read(10*1024*1024+1),request.form.get('product_name',''),request.form.get('facts','')))

    @app.get('/api/bridge/selling-points/current')
    def selling_current():return jsonify(service.snapshot())

    @app.post('/api/bridge/selling-points/<identifier>/generate')
    def selling_generate(identifier):return jsonify(service.generate(identifier,body({'paid_confirmed'})['paid_confirmed']))

    @app.post('/api/bridge/selling-points/<identifier>/draft')
    def selling_draft(identifier):
        value=body({'headline','points','draft_revision'})
        return jsonify(service.draft(identifier,value['headline'],value['points'],value['draft_revision']))

    @app.post('/api/bridge/selling-points/<identifier>/render')
    def selling_render(identifier):return jsonify(service.render(identifier,body({'draft_revision'})['draft_revision']))

    @app.post('/api/bridge/selling-points/<identifier>/retry-upload')
    def selling_retry(identifier):body(set());return jsonify(service.retry_upload(identifier))

    @app.post('/api/bridge/selling-points/<identifier>/clear')
    def selling_clear(identifier):body(set());return jsonify(service.clear(identifier))

    @app.get('/api/bridge/selling-points/<identifier>/images/<kind>')
    def selling_image(identifier,kind):
        data,mime=service.image(identifier,kind)
        response=Response(data,mimetype=mime)
        if kind=='result':response.headers['Content-Disposition']='inline; filename="selling-points.png"'
        return response
