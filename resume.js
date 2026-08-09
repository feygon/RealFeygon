module.exports = (function() {
    
    var express = require('express');
    var path = require('path');
    var router = express.Router();

	// /resume/ is the URL printed on the CV, so it must land on the current
	// resume. It previously served the 2018 game-project resume, now mothballed
	// to docs/archive/. Permanent redirect: the canonical resume is the SPA.
	router.get('/',function(req, res){
		res.redirect(301, '/spa-resume/');
	});

	router.get('/AutisticWorkPreferences/', function(req,res){
		res.sendFile(path.join(__dirname, 'docs', 'AutisticWorkPreferences.htm'));
	});

	// /resume/DeceiversBlade/ removed: it sendFile'd "Sword of the Deceiver X.html",
	// which is not in the repo, so the route threw and returned 500 rather than 404.
	// Not worth restoring — the Deceiver's Blade artifact is served by /illusion/.

    return router;
})();