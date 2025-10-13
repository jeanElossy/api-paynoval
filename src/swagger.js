const swaggerUi = require('swagger-ui-express');
const yaml = require('yamljs');
const path = require('path');

module.exports = (app) => {
  const spec = yaml.load(path.join(__dirname, '../..', 'docs', 'openapi.yaml'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, {
    explorer: true,
    customSiteTitle: 'PayNoval Interne API'
  }));
};
