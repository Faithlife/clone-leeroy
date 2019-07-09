var gulp = require('gulp');
var babel = require('gulp-babel');
var eslint = require('gulp-eslint');
var watch = require('gulp-watch');
var batch = require('gulp-batch');

gulp.task('babel', () => {
  return gulp.src(['src/*.js'])
    .pipe(babel({
      "presets": [
        ["@babel/preset-env", {
          "targets": {
            "node": "8",
          }
        }]
      ]
    }))
    .pipe(gulp.dest('dist'));
});

gulp.task('lint', () => {
  return gulp.src(['src/*.js'])
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(eslint.failAfterError());
});

gulp.task('watch', () => {
    watch('src/*.js', batch((events, done) => {
        gulp.start('default', done);
    }));
});

gulp.task('default', gulp.series('lint', 'babel'), () => {
  console.log('Success!');
});